import {
  GRACE_DAYS,
  PLANS,
  licenseState,
  seatCeiling,
  type PlanId,
  type SubscriptionDTO,
  type SubscriptionStatus,
} from '@rd/contracts';
import type { UserActor } from '../../context';
import { one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
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
    entitlements: sub.status === 'trialing' ? [...PLANS.pro.entitlements] : [...plan.entitlements],
  };
}

/**
 * Plan/seat change through the manual provider: applies immediately. The Stripe
 * provider will instead create a checkout/portal session and apply on webhook.
 */
export async function changePlan(
  q: Queryable,
  actor: UserActor,
  input: { plan: PlanId; seats: number },
  now: Date,
  requestId?: string,
): Promise<SubscriptionDTO> {
  const before = await currentSubscription(q, actor.organizationId, now);
  const { billable } = await seatCounts(q, actor.organizationId);
  const plan = PLANS[input.plan];
  if (plan.max_billable_seats !== null && billable > plan.max_billable_seats) {
    throw errors.validation(
      `The ${plan.name} plan allows ${plan.max_billable_seats} tracked users; ${billable} are tracked. Turn tracking off for some users first.`,
    );
  }
  const seats = input.plan === 'free' ? 0 : input.seats;
  if (input.plan !== 'free' && seats < billable) {
    throw errors.validation(`Licence at least ${billable} seats — that many users are tracked.`);
  }
  await q.query(
    `UPDATE subscriptions SET plan = $2, seats = $3, status = 'active', grace_ends_at = NULL, trial_ends_at = NULL,
       current_period_start = $4, current_period_end = $5, updated_at = now()
     WHERE organization_id = $1`,
    [actor.organizationId, input.plan, seats, now.toISOString(), new Date(now.getTime() + 30 * DAY).toISOString()],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'billing.plan_changed',
    targetType: 'subscription',
    targetId: actor.organizationId,
    requestId,
    metadata: { from_plan: before.plan, to_plan: input.plan, from_seats: before.seats, to_seats: seats },
  });
  return subscriptionDTO(q, actor.organizationId, now);
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
