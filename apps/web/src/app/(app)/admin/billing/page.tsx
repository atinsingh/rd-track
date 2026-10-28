'use client';

import { useState } from 'react';
import { PLANS, PLAN_IDS, type PlanId, type SubscriptionDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Banner, Card, Meter, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatMoney, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from './billing.module.css';

/** Plan cards (commercial model §2). Privacy protections are in every plan — never an upsell. */
const PLAN_FEATURES: Record<PlanId, { text: string; on: boolean }[]> = {
  free: [
    { text: 'Sessions, projects, activity, app names', on: true },
    { text: 'Employee self-service and corrections', on: true },
    { text: 'Reports and CSV export', on: true },
    { text: 'Team and project policies', on: false },
    { text: 'Screenshots', on: false },
    { text: 'SSO, API, legal hold', on: false },
  ],
  standard: [
    { text: 'Everything in Free, unlimited people', on: true },
    { text: 'Manager approval for corrections', on: true },
    { text: 'Reports and CSV export', on: true },
    { text: 'Team and project policies', on: false },
    { text: 'Screenshots', on: false },
    { text: 'SSO, API, legal hold', on: false },
  ],
  pro: [
    { text: 'Everything in Standard', on: true },
    { text: 'Team, project and device policies', on: true },
    { text: 'Optional, policy-governed screenshots', on: true },
    { text: 'SSO / SCIM, REST API, webhooks', on: true },
    { text: 'Legal hold, longer retention', on: true },
    { text: 'Data residency, MDM rollout', on: true },
  ],
};

const STATUS_LABEL: Record<SubscriptionDTO['status'], string> = {
  trialing: 'Pro trial',
  active: 'Active',
  past_due: 'Payment overdue',
  grace: 'Grace period',
  inactive: 'Inactive',
  canceled: 'Canceled',
};

const day = (iso: string | null, tz: string) => (iso ? formatDateTime(iso, tz).replace(/, \d\d:\d\d$/, '') : null);

function statusLine(sub: SubscriptionDTO, tz: string): string {
  const base = STATUS_LABEL[sub.status];
  if (sub.status === 'trialing' && sub.trial_ends_at) return `${base} · ends ${day(sub.trial_ends_at, tz)}`;
  if (sub.license === 'grace' && sub.grace_ends_at) return `${base} · until ${day(sub.grace_ends_at, tz)}`;
  if (sub.license === 'active' && sub.current_period_end) return `${base} · renews ${day(sub.current_period_end, tz)}`;
  return base;
}

function StatusBanner({ sub, tz }: { sub: SubscriptionDTO; tz: string }) {
  if (sub.status === 'trialing')
    return (
      <Banner tag="TRIAL" title={`Pro trial${sub.trial_ends_at ? ` until ${day(sub.trial_ends_at, tz)}` : ''}`}>
        Screenshots stay off during the trial unless you publish a screenshot policy. Choose a plan below to keep going.
      </Banner>
    );
  if (sub.license === 'grace')
    return (
      <Banner tone="warn" role="status" title="Payment failed — grace period">
        Everything keeps working{sub.grace_ends_at ? ` until ${day(sub.grace_ends_at, tz)}` : ' for 14 days'}. After that, agents stop
        collecting and tell employees why. No data is deleted.
      </Banner>
    );
  if (sub.license === 'inactive')
    return (
      <Banner tone="error" role="status" title="Subscription inactive — nothing is being collected">
        Agents have stopped tracking with a visible notice. Reports and exports stay readable for 90 days. Choose a plan to resume.
      </Banner>
    );
  return null;
}

/** One cell per seat up to the ceiling: used, licensed-but-free, overage allowance. */
function SeatCells({ sub }: { sub: SubscriptionDTO }) {
  const total = Math.max(sub.seat_ceiling, sub.billable_seats, sub.seats);
  const label = `${sub.billable_seats} of ${sub.seats} licensed seats in use; ${
    sub.seat_ceiling > sub.seats ? `${sub.seat_ceiling - sub.seats} more allowed as overage before adding seats` : 'no overage on this plan'
  }.`;
  if (total > 60 || total === 0)
    return <Meter value={sub.billable_seats} max={Math.max(total, 1)} mark={sub.seats} label={label} scale={['0', `${sub.seat_ceiling} ceiling`]} />;
  return (
    <div role="img" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={s.cells}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cx(
              s.cell,
              i < sub.billable_seats && (i < sub.seats ? s.cellUsed : s.cellOverUsed),
              i >= sub.billable_seats && i >= sub.seats && s.cellOverage,
            )}
          />
        ))}
      </div>
      <div className={s.cellScale} aria-hidden="true">
        <span>0</span>
        <span>{sub.seats} licensed</span>
        <span>{sub.seat_ceiling} ceiling</span>
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { access, timezone: tz, reload: reloadMe } = useMe();
  const sub = useApi(access.isAdmin ? 'billing:subscription' : null, (signal) => rd.billing.subscription(signal));
  const [seatsDraft, setSeatsDraft] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<PlanId | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const seatAction = useAction();
  const planAction = useAction();
  if (!access.isAdmin) return <NoAccess what="Billing is managed by org admins." />;
  if (sub.error) return <ErrorState error={sub.error} onRetry={sub.reload} />;
  if (!sub.data) return <Loading label="Loading your subscription" />;

  const d = sub.data;
  const plan = PLANS[d.plan];
  const seatsText = seatsDraft ?? String(d.seats);
  const seats = Number(seatsText);
  const maxSeats = plan.max_billable_seats ?? 100_000;
  const minSeats = Math.min(d.billable_seats, maxSeats);
  const seatsValid = /^\d+$/.test(seatsText) && seats >= minSeats && seats <= maxSeats;
  const pricePerSeat = d.price_per_seat_cents;

  const apply = async (target: PlanId, n: number, action: typeof seatAction) => {
    const r = await action.run(() => rd.billing.changePlan(target, n));
    if (r) {
      sub.mutate(() => r);
      setSeatsDraft(null);
      setSwitchTo(null);
      setSaved(`You're on ${r.plan_name} with ${plural(r.seats, 'licensed seat')}`);
      reloadMe();
    }
    return !!r;
  };

  const target = switchTo ? PLANS[switchTo] : null;
  const targetSeats = target ? Math.min(Math.max(d.seats, d.billable_seats), target.max_billable_seats ?? 100_000) : 0;
  const tooManyForTarget = !!target && target.max_billable_seats !== null && d.billable_seats > target.max_billable_seats;
  const losesScreenshots = !!target && d.entitlements.includes('screenshots') && !target.entitlements.includes('screenshots');
  const losesScopes = !!target && d.entitlements.includes('scoped_policies') && !target.entitlements.includes('scoped_policies');

  return (
    <>
      <PageHeader
        eyebrow="Admin · Billing"
        title="Plan and licences"
        description="You pay for people who track time. Admins, auditors and managers who don't track are free."
      />
      <StatusBanner sub={d} tz={tz} />
      {saved ? (
        <Banner role="status" title={saved} actions={<Button size="sm" variant="quiet" onClick={() => setSaved(null)}>Dismiss</Button>}>
          What&apos;s collected follows the plan at the agents&apos; next policy check; employees are told when anything turns off.
        </Banner>
      ) : null}

      <div className={s.top}>
        <section className={s.planCard} aria-labelledby="plan-h">
          <span className={s.cardLabel}>Current plan</span>
          <div className={s.planLine}>
            <h2 id="plan-h" className={s.planName}>
              {d.plan_name}
            </h2>
            <span className={s.planPrice}>{pricePerSeat === 0 ? 'Free · up to 2 people' : `${formatMoney(pricePerSeat)} per user / month`}</span>
          </div>
          <div className={s.status}>
            <span className={cx(s.statusDot, d.license !== 'active' && s.statusDotWarn)} aria-hidden="true" />
            {statusLine(d, tz)}
          </div>
          <div className={s.cost}>
            <span>Estimated this month</span>
            <span className={s.costValue}>{formatMoney(d.estimated_monthly_cents)}</span>
          </div>
          <span className={s.fine}>
            {pricePerSeat === 0
              ? 'No charge on Free.'
              : `${plural(Math.max(d.seats, d.billable_seats), 'seat')} × ${formatMoney(pricePerSeat)}. Seats added mid-month are prorated by day.`}
          </span>
        </section>

        <section className={s.seats} aria-labelledby="seats-h">
          <h2 id="seats-h">Seats</h2>
          <SeatCells sub={d} />
          <dl className={s.stats}>
            <div className={s.stat}>
              <dt>Tracked (billable)</dt>
              <dd>{d.billable_seats}</dd>
            </div>
            <div className={s.stat}>
              <dt>Licensed</dt>
              <dd>{d.seats}</dd>
            </div>
            <div className={s.stat}>
              <dt>Overage allowed</dt>
              <dd>{plan.allows_overage ? `+${Math.max(0, d.seat_ceiling - d.seats)}` : '—'}</dd>
            </div>
            <div className={s.stat}>
              <dt>Free viewers</dt>
              <dd>{d.viewer_seats}</dd>
            </div>
          </dl>
          <form
            className={s.seatForm}
            onSubmit={(e) => {
              e.preventDefault();
              if (seatsValid && seats !== d.seats) void apply(d.plan, seats, seatAction);
            }}
          >
            <label className={s.seatLabel} htmlFor="seats">
              Licensed seats
              <input
                id="seats"
                className={s.seatInput}
                type="number"
                inputMode="numeric"
                min={minSeats}
                max={maxSeats}
                step={1}
                value={seatsText}
                aria-describedby="seats-hint"
                aria-invalid={!seatsValid || undefined}
                onChange={(e) => setSeatsDraft(e.target.value)}
              />
            </label>
            <Button type="submit" variant="primary" disabled={seatAction.busy || !seatsValid || seats === d.seats}>
              {seatAction.busy ? 'Updating…' : 'Update seats →'}
            </Button>
            <span id="seats-hint" className="small secondary">
              {plan.max_billable_seats !== null
                ? `Free covers up to ${plan.max_billable_seats} people who track time.`
                : `At least ${d.billable_seats} — that many people track time.`}
              {seatsValid && seats !== d.seats && pricePerSeat > 0 ? ` New estimate ${formatMoney(pricePerSeat * Math.max(seats, d.billable_seats))} / month.` : ''}
            </span>
          </form>
          <ActionError error={seatAction.error} />
        </section>
      </div>

      <Card title="Plans" subtitle="Privacy protections — self-service, corrections, deletion requests, access audit — are in every plan.">
        <div className={s.plans}>
          {PLAN_IDS.map((id) => {
            const p = PLANS[id];
            const current = id === d.plan;
            return (
              <article key={id} className={cx(s.plan, current && s.planCurrent)} aria-labelledby={`plan-${id}`}>
                <div className={s.planHead}>
                  <h3 id={`plan-${id}`}>{p.name}</h3>
                  {current ? <span className={s.tag}>CURRENT</span> : null}
                </div>
                <div className={s.price}>
                  <span className={s.priceValue}>{p.price_per_seat_cents === 0 ? '$0' : formatMoney(p.price_per_seat_cents).replace(/\.00$/, '')}</span>
                  <span className="small muted">{p.max_billable_seats !== null ? `up to ${p.max_billable_seats} people` : 'per user / month'}</span>
                </div>
                <ul className={s.features}>
                  {PLAN_FEATURES[id].map((f) => (
                    <li key={f.text} className={f.on ? undefined : s.off}>
                      <span className={s.mark} aria-hidden="true">
                        {f.on ? '✓' : '–'}
                      </span>
                      <span>
                        {f.text}
                        <span className="visually-hidden">{f.on ? ' (included)' : ' (not included)'}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {current ? (
                  <Button className={s.currentBtn} disabled aria-disabled="true">
                    Current plan
                  </Button>
                ) : (
                  <Button className={s.planBtn} onClick={() => setSwitchTo(id)}>
                    Switch to {p.name}
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      </Card>

      <Card title="If a payment fails">
        <p className="secondary">
          Everything keeps working for a 14-day grace period. After that, agents stop tracking and tell employees why — nothing is collected silently.
          Reports and exports stay readable for 90 days, and retention keeps deleting data on schedule.
        </p>
      </Card>

      <Dialog
        open={switchTo !== null}
        onClose={() => {
          setSwitchTo(null);
          planAction.reset();
        }}
        title={target ? `Switch to ${target.name}?` : 'Switch plan'}
        footer={
          <>
            <Button onClick={() => setSwitchTo(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={planAction.busy || tooManyForTarget}
              onClick={() => switchTo && void apply(switchTo, targetSeats, planAction)}
            >
              {planAction.busy ? 'Switching…' : `Switch to ${target?.name ?? ''} →`}
            </Button>
          </>
        }
      >
        {target ? (
          <>
            <dl className={s.dlConfirm}>
              <dt>Price</dt>
              <dd>{target.price_per_seat_cents === 0 ? '$0' : `${formatMoney(target.price_per_seat_cents)} per user / month`}</dd>
              <dt>Licensed seats</dt>
              <dd>{targetSeats}</dd>
              <dt>Estimated monthly</dt>
              <dd>{formatMoney(target.price_per_seat_cents * Math.max(targetSeats, d.billable_seats))}</dd>
            </dl>
            {tooManyForTarget ? (
              <Banner tone="warn" role="alert" title={`${d.billable_seats} people track time; ${target.name} allows ${target.max_billable_seats}`}>
                Turn tracking off for {d.billable_seats - (target.max_billable_seats ?? 0)} of them in People first.
              </Banner>
            ) : null}
            {losesScreenshots || losesScopes ? (
              <Banner tone="warn" title={`${target.name} collects less`}>
                {losesScreenshots ? 'Screenshots and website domains stop at the agents’ next policy check; existing screenshots keep their retention date. ' : ''}
                {losesScopes ? 'Team, project and device policies stop applying; only the organization policy remains. ' : ''}
                No confirmation from employees is needed because nothing new is collected — they are notified.
              </Banner>
            ) : null}
            <ActionError error={planAction.error} />
          </>
        ) : null}
      </Dialog>
    </>
  );
}
