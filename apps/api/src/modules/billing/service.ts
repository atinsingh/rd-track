import {
  GRACE_DAYS,
  PLANS,
  licenseState,
  seatCeiling,
  type PlanId,
  type SubscriptionDTO,
  type SubscriptionStatus,
} from '@rd/contracts';
import type { ChangePlanResponse } from '@rd/contracts';
import { StripeClient, type StripeEvent } from '../../billing/stripe';
import type { Deps, UserActor } from '../../context';
import { one, type Queryable } from '../../db/pool';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';

interface SubscriptionRow {
  organization_id: string;
  plan: PlanId;
  status: SubscriptionStatus;
  seats: number;
  price_per_seat_cents: number | null;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  current_period_end: string | null;
  provider: 'manual' | 'stripe';
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  provider_subscription_item_id: string | null;
  cancel_at_period_end: boolean;
}

const DAY = 86_400_000;

export async function seatCounts(q: Queryable, orgId: string): Promise<{ billable: number; viewer: number }> {
  const r = await one<{ billable: number; viewer: number }>(
    q,
    `SELECT count(*) FILTER (WHERE tracking_enabled)::int AS billable,
            count(*) FILTER (WHERE NOT tracking_enabled)::int AS viewer
     FROM users WHERE organization_id = $1 AND status = 'active'`,
    [orgId],
  );
  return r ?? { billable: 0, viewer: 0 };
}

/**
 * Loads the subscription and applies any time-based transition that is due
 * (trial end, grace end) so every caller sees the current state.
 */
export async function currentSubscription(q: Queryable, orgId: string, now: Date): Promise<SubscriptionRow> {
  let sub = await one<SubscriptionRow>(q, 'SELECT * FROM subscriptions WHERE organization_id = $1', [orgId]);
  if (!sub) throw errors.notFound('Subscription');

  if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) <= now) {
    // Trial ends on Free; organizations with more than 2 tracked users get a grace period to choose a plan.
    const { billable } = await seatCounts(q, orgId);
    const over = billable > (PLANS.free.max_billable_seats ?? 0);
    sub = (await one<SubscriptionRow>(
      q,
      `UPDATE subscriptions SET plan = 'free', seats = 0, status = $2, grace_ends_at = $3, updated_at = now()
       WHERE organization_id = $1 RETURNING *`,
      [orgId, over ? 'grace' : 'active', over ? new Date(now.getTime() + GRACE_DAYS * DAY).toISOString() : null],
    ))!;
  }
  if (sub.status === 'past_due' && !sub.grace_ends_at) {
    sub = (await one<SubscriptionRow>(
      q,
      `UPDATE subscriptions SET status = 'grace', grace_ends_at = $2, updated_at = now() WHERE organization_id = $1 RETURNING *`,
      [orgId, new Date(now.getTime() + GRACE_DAYS * DAY).toISOString()],
    ))!;
  }
  if (sub.status === 'grace' && sub.grace_ends_at && new Date(sub.grace_ends_at) <= now) {
    sub = (await one<SubscriptionRow>(
      q,
      `UPDATE subscriptions SET status = 'inactive', updated_at = now() WHERE organization_id = $1 RETURNING *`,
      [orgId],
    ))!;
  }
  return sub;
}

export async function currentPlan(q: Queryable, orgId: string, now: Date): Promise<PlanId> {
  return (await currentSubscription(q, orgId, now)).plan;
}

/**
 * Throws unless one more billable seat fits (commercial model §4). Call inside the
 * transaction that enables tracking or creates a tracked user.
 */
export async function assertSeatAvailable(q: Queryable, orgId: string, now: Date): Promise<void> {
  const sub = await currentSubscription(q, orgId, now);
  const { billable } = await seatCounts(q, orgId);
  const ceiling = seatCeiling(sub.plan, sub.seats);
  if (billable + 1 <= ceiling) return;
  if (sub.plan === 'free') {
    throw errors.paymentRequired('The Free plan includes up to 2 tracked users. Choose Standard or Pro to add more.');
  }
  throw errors.conflict('seat_limit_reached', `All ${sub.seats} licensed seats (plus overage allowance) are in use. Add seats to continue.`, {
    seats: sub.seats,
    billable,
    ceiling,
  });
}

/** Gate for agent traffic: a lapsed licence or a user without a seat stops collection visibly. */
export async function assertLicensedForTracking(q: Queryable, orgId: string, userId: string, now: Date): Promise<void> {
  const sub = await currentSubscription(q, orgId, now);
  if (licenseState(sub.status) === 'inactive') throw errors.subscriptionInactive();
  const u = await one<{ tracking_enabled: boolean }>(q, 'SELECT tracking_enabled FROM users WHERE id = $1', [userId]);
  if (!u?.tracking_enabled) throw errors.seatUnavailable();
}

export async function subscriptionDTO(q: Queryable, orgId: string, now: Date): Promise<SubscriptionDTO> {
  const sub = await currentSubscription(q, orgId, now);
  const { billable, viewer } = await seatCounts(q, orgId);
  const plan = PLANS[sub.plan];
  const price = sub.price_per_seat_cents ?? plan.price_per_seat_cents;
  const chargedSeats = sub.plan === 'free' ? 0 : Math.max(sub.seats, billable);
  return {
    plan: sub.plan,
    plan_name: sub.status === 'trialing' ? `${plan.name} trial` : plan.name,
    status: sub.status,
    license: licenseState(sub.status),
    seats: sub.plan === 'free' ? (plan.max_billable_seats ?? 0) : sub.seats,
    billable_seats: billable,
    viewer_seats: viewer,
    seat_ceiling: seatCeiling(sub.plan, sub.seats),
    price_per_seat_cents: price,
    estimated_monthly_cents: sub.status === 'trialing' ? 0 : chargedSeats * price,
    trial_ends_at: sub.trial_ends_at,
    grace_ends_at: sub.grace_ends_at,
    current_period_end: sub.current_period_end,
    billing_provider: sub.provider,
    cancel_at_period_end: sub.cancel_at_period_end,
    entitlements: sub.status === 'trialing' ? [...PLANS.pro.entitlements] : [...plan.entitlements],
  };
}

function validatePlanChange(plan: PlanId, seats: number, billable: number) {
  const p = PLANS[plan];
  if (p.max_billable_seats !== null && billable > p.max_billable_seats) {
    throw errors.validation(
      `The ${p.name} plan allows ${p.max_billable_seats} tracked users; ${billable} are tracked. Turn tracking off for some users first.`,
    );
  }
  if (plan !== 'free' && seats < billable) {
    throw errors.validation(`Licence at least ${billable} seats — that many users are tracked.`);
  }
}

function stripeFor(deps: Pick<Deps, 'config'>): StripeClient {
  return new StripeClient(deps.config.billing.stripe.secretKey, deps.config.billing.stripe.apiBase);
}

function stripePrice(deps: Pick<Deps, 'config'>, plan: PlanId): string {
  const price = plan === 'pro' ? deps.config.billing.stripe.prices.pro : deps.config.billing.stripe.prices.standard;
  if (!price) throw new AppError(500, 'billing_not_configured', `No Stripe price configured for ${plan}`);
  return price;
}

/**
 * Plan/seat change. With the manual provider (invoiced contracts, development) it applies
 * immediately. With Stripe, an existing subscription is updated in place (prorated) and
 * mirrored locally; otherwise the admin is sent to Checkout and the webhook applies it.
 */
export async function changePlan(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { plan: PlanId; seats: number },
  requestId?: string,
): Promise<ChangePlanResponse> {
  const now = deps.now();
  const orgId = actor.organizationId;
  const before = await currentSubscription(q, orgId, now);
  const { billable } = await seatCounts(q, orgId);
  const seats = input.plan === 'free' ? 0 : input.seats;
  validatePlanChange(input.plan, seats, billable);

  let checkoutUrl: string | null = null;
  let applyLocally = true;
  if (deps.config.billing.provider === 'stripe') {
    const stripe = stripeFor(deps);
    const hasLiveSub = before.provider === 'stripe' && before.provider_subscription_id && before.provider_subscription_item_id;
    if (input.plan === 'free') {
      if (hasLiveSub) {
        // Paid time already bought runs to period end; the deletion webhook moves the org to Free.
        await stripe.cancelAtPeriodEnd(before.provider_subscription_id!);
        await q.query(`UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE organization_id = $1`, [orgId]);
        applyLocally = false;
      }
    } else if (hasLiveSub) {
      await stripe.updateSubscriptionItem({
        subscription: before.provider_subscription_id!,
        item: before.provider_subscription_item_id!,
        price: stripePrice(deps, input.plan),
        quantity: seats,
      });
    } else {
      let customer = before.provider_customer_id;
      if (!customer) {
        const admin = await one<{ email: string; org_name: string }>(
          q,
          `SELECT u.email, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1`,
          [actor.userId],
        );
        customer = (await stripe.createCustomer({ name: admin!.org_name, email: admin!.email, organizationId: orgId })).id;
        await q.query(`UPDATE subscriptions SET provider_customer_id = $2, updated_at = now() WHERE organization_id = $1`, [orgId, customer]);
      }
      const session = await stripe.createCheckoutSession({
        customer,
        price: stripePrice(deps, input.plan),
        quantity: seats,
        organizationId: orgId,
        successUrl: `${deps.config.webUrl}/admin/billing?checkout=success`,
        cancelUrl: `${deps.config.webUrl}/admin/billing?checkout=cancelled`,
      });
      checkoutUrl = session.url;
      applyLocally = false;
    }
  }

  if (applyLocally) {
    await q.query(
      `UPDATE subscriptions SET plan = $2, seats = $3, status = 'active', grace_ends_at = NULL, trial_ends_at = NULL,
         current_period_start = $4, current_period_end = COALESCE(current_period_end, $5), updated_at = now()
       WHERE organization_id = $1`,
      [orgId, input.plan, seats, now.toISOString(), new Date(now.getTime() + 30 * DAY).toISOString()],
    );
  }
  await audit(q, {
    organizationId: orgId,
    actor,
    action: checkoutUrl ? 'billing.checkout_started' : 'billing.plan_changed',
    targetType: 'subscription',
    targetId: orgId,
    requestId,
    metadata: { from_plan: before.plan, to_plan: input.plan, from_seats: before.seats, to_seats: seats, provider: deps.config.billing.provider },
  });
  return { subscription: await subscriptionDTO(q, orgId, now), checkout_url: checkoutUrl };
}

export async function billingPortalUrl(deps: Deps, q: Queryable, actor: UserActor): Promise<string> {
  const sub = await currentSubscription(q, actor.organizationId, deps.now());
  if (deps.config.billing.provider !== 'stripe' || !sub.provider_customer_id) {
    throw errors.conflict('no_billing_account', 'This organization has no online billing account yet.');
  }
  const r = await stripeFor(deps).createPortalSession({ customer: sub.provider_customer_id, returnUrl: `${deps.config.webUrl}/admin/billing` });
  return r.url;
}

const STRIPE_STATUS: Record<string, SubscriptionStatus | undefined> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
};

/**
 * Applies one verified Stripe event. Idempotent: each event id is processed once.
 * Returns what happened, for logging.
 */
export async function applyStripeEvent(deps: Deps, q: Queryable, event: StripeEvent): Promise<string> {
  const fresh = await one(
    q,
    `INSERT INTO billing_webhook_events (provider, event_id, event_type) VALUES ('stripe', $1, $2) ON CONFLICT DO NOTHING RETURNING event_id`,
    [event.id, event.type],
  );
  if (!fresh) return 'duplicate';
  const obj = event.data.object;
  const now = deps.now();

  const orgFor = async (): Promise<string | null> => {
    const fromMeta = obj.metadata?.organization_id ?? obj.client_reference_id ?? obj.subscription_details?.metadata?.organization_id;
    if (fromMeta) {
      const r = await one<{ organization_id: string }>(q, 'SELECT organization_id FROM subscriptions WHERE organization_id = $1', [fromMeta]);
      if (r) return r.organization_id;
    }
    if (typeof obj.customer === 'string') {
      const r = await one<{ organization_id: string }>(q, 'SELECT organization_id FROM subscriptions WHERE provider_customer_id = $1', [obj.customer]);
      if (r) return r.organization_id;
    }
    return null;
  };
  const orgId = await orgFor();
  if (!orgId) return 'ignored:unknown_organization';

  let outcome = 'ignored';
  switch (event.type) {
    case 'checkout.session.completed':
      await q.query(
        `UPDATE subscriptions SET provider = 'stripe', provider_customer_id = $2, provider_subscription_id = COALESCE($3, provider_subscription_id), updated_at = now()
         WHERE organization_id = $1`,
        [orgId, obj.customer, obj.subscription ?? null],
      );
      outcome = 'linked';
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const item = obj.items?.data?.[0];
      const priceId = item?.price?.id;
      const prices = deps.config.billing.stripe.prices;
      const plan: PlanId | null = priceId === prices.pro ? 'pro' : priceId === prices.standard ? 'standard' : null;
      const status = STRIPE_STATUS[obj.status as string];
      if (!plan || !status) {
        outcome = `ignored:${plan ? 'status' : 'price'}`;
        break;
      }
      const periodEnd = item?.current_period_end ?? obj.current_period_end;
      await q.query(
        `UPDATE subscriptions SET provider = 'stripe', plan = $2, seats = $3, status = $4,
           provider_customer_id = $5, provider_subscription_id = $6, provider_subscription_item_id = $7,
           cancel_at_period_end = $8, current_period_end = $9, trial_ends_at = NULL,
           grace_ends_at = CASE WHEN $4 = 'active' THEN NULL ELSE grace_ends_at END, updated_at = now()
         WHERE organization_id = $1`,
        [orgId, plan, item.quantity ?? 0, status, obj.customer, obj.id, item.id, Boolean(obj.cancel_at_period_end),
          periodEnd ? new Date(periodEnd * 1000).toISOString() : null],
      );
      outcome = `subscription:${plan}:${status}`;
      break;
    }
    case 'customer.subscription.deleted': {
      const { billable } = await seatCounts(q, orgId);
      const over = billable > (PLANS.free.max_billable_seats ?? 0);
      await q.query(
        `UPDATE subscriptions SET plan = 'free', seats = 0, status = $2, grace_ends_at = $3,
           provider_subscription_id = NULL, provider_subscription_item_id = NULL, cancel_at_period_end = false, updated_at = now()
         WHERE organization_id = $1`,
        [orgId, over ? 'grace' : 'active', over ? new Date(now.getTime() + GRACE_DAYS * DAY).toISOString() : null],
      );
      outcome = over ? 'downgraded_to_free_grace' : 'downgraded_to_free';
      break;
    }
    case 'invoice.payment_failed':
      await q.query(`UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE organization_id = $1 AND status = 'active'`, [orgId]);
      outcome = 'past_due';
      break;
    case 'invoice.paid':
      await q.query(
        `UPDATE subscriptions SET status = 'active', grace_ends_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND status IN ('past_due', 'grace', 'inactive') AND plan <> 'free'`,
        [orgId],
      );
      outcome = 'paid';
      break;
  }
  await audit(q, {
    organizationId: orgId,
    actor: { kind: 'system' },
    action: 'billing.webhook',
    targetType: 'subscription',
    targetId: orgId,
    metadata: { provider: 'stripe', event_type: event.type, event_id: event.id, outcome },
  });
  return outcome;
}

export async function snapshotSeats(q: Queryable, now: Date): Promise<number> {
  const r = await q.query(
    `INSERT INTO seat_usage_daily (organization_id, day, billable_seats, viewer_seats)
     SELECT organization_id, $1::date,
            count(*) FILTER (WHERE tracking_enabled AND status = 'active'),
            count(*) FILTER (WHERE NOT tracking_enabled AND status = 'active')
     FROM users GROUP BY organization_id
     ON CONFLICT (organization_id, day) DO UPDATE
       SET billable_seats = GREATEST(seat_usage_daily.billable_seats, EXCLUDED.billable_seats),
           viewer_seats = EXCLUDED.viewer_seats`,
    [now.toISOString().slice(0, 10)],
  );
  return r.rowCount ?? 0;
}
