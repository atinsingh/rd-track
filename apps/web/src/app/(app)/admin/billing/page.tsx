'use client';

import { useState, useSyncExternalStore } from 'react';

const noopSubscribe = () => () => {};
import { PLANS, PLAN_IDS, type BillingInterval, type PlanId, type SubscriptionDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Field';
import { Banner, Card, Meter, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { annualSavingPercent, invoiceCents, price, seatPriceText } from '@/lib/billing';
import { cx } from '@/lib/cx';
import { formatMoney, formatPercent } from '@/lib/format';
import { t, tPlural, type MessageKey } from '@/lib/i18n';
import { currentLocale } from '@/lib/locale';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from './billing.module.css';

/** Plan cards (commercial model §2). Privacy protections are in every plan — never an upsell. */
const PLAN_FEATURES: Record<PlanId, { key: string; on: boolean }[]> = {
  free: [
    { key: 'sessions', on: true },
    { key: 'selfService', on: true },
    { key: 'reports', on: true },
    { key: 'policies', on: false },
    { key: 'screenshots', on: false },
    { key: 'sso', on: false },
  ],
  standard: [
    { key: 'everythingFree', on: true },
    { key: 'managerApproval', on: true },
    { key: 'reports', on: true },
    { key: 'policies', on: false },
    { key: 'screenshots', on: false },
    { key: 'sso', on: false },
  ],
  pro: [
    { key: 'everythingStandard', on: true },
    { key: 'allPolicies', on: true },
    { key: 'optScreenshots', on: true },
    { key: 'ssoScim', on: true },
    { key: 'legalHold', on: true },
    { key: 'residency', on: true },
  ],
};

const statusLabel = (st: SubscriptionDTO['status']) => t(`money.billing.status.${st}`);

/** "27 Oct 2026" in `tz`, as the locale writes dates. */
const day = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat(currentLocale(), { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : null;

function statusLine(sub: SubscriptionDTO, tz: string): string {
  const status = statusLabel(sub.status);
  if (sub.status === 'trialing' && sub.trial_ends_at) return t('money.billing.statusEnds', { status, date: day(sub.trial_ends_at, tz)! });
  if (sub.license === 'grace' && sub.grace_ends_at) return t('money.billing.statusUntil', { status, date: day(sub.grace_ends_at, tz)! });
  if (sub.license === 'active' && sub.current_period_end) return t('money.billing.statusRenews', { status, date: day(sub.current_period_end, tz)! });
  return status;
}

function StatusBanner({ sub, tz }: { sub: SubscriptionDTO; tz: string }) {
  if (sub.status === 'trialing')
    return (
      <Banner
        tag={t('money.billing.trialTag')}
        title={sub.trial_ends_at ? t('money.billing.trialUntil', { date: day(sub.trial_ends_at, tz)! }) : t('money.billing.status.trialing')}
      >
        {t('money.billing.trialBody')}
      </Banner>
    );
  if (sub.license === 'grace')
    return (
      <Banner tone="warn" role="status" title={t('money.billing.graceTitle')}>
        {sub.grace_ends_at ? t('money.billing.graceUntil', { date: day(sub.grace_ends_at, tz)! }) : t('money.billing.graceDays')}
      </Banner>
    );
  if (sub.license === 'inactive')
    return (
      <Banner tone="error" role="status" title={t('money.billing.inactiveTitle')}>
        {t('money.billing.inactiveBody')}
      </Banner>
    );
  return null;
}

/** One cell per seat up to the ceiling: used, licensed-but-free, overage allowance. */
function SeatCells({ sub }: { sub: SubscriptionDTO }) {
  const total = Math.max(sub.seat_ceiling, sub.billable_seats, sub.seats);
  const label = t('money.billing.seatsLabel', {
    used: sub.billable_seats,
    seats: sub.seats,
    rest: sub.seat_ceiling > sub.seats ? t('money.billing.seatsOverage', { n: sub.seat_ceiling - sub.seats }) : t('money.billing.seatsNoOverage'),
  });
  if (total > 60 || total === 0)
    return <Meter value={sub.billable_seats} max={Math.max(total, 1)} mark={sub.seats} label={label} scale={['0', t('money.billing.ceiling', { n: sub.seat_ceiling })]} />;
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
        <span>{t('money.billing.licensedN', { n: sub.seats })}</span>
        <span>{t('money.billing.ceiling', { n: sub.seat_ceiling })}</span>
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { access, timezone: tz, reload: reloadMe } = useMe();
  const sub = useApi(access.isAdmin ? 'billing:subscription' : null, (signal) => rd.billing.subscription(signal));
  const [seatsDraft, setSeatsDraft] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<{ plan: PlanId; interval: BillingInterval } | null>(null);
  const [term, setTerm] = useState<BillingInterval | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const seatAction = useAction();
  const planAction = useAction();
  const portalAction = useAction();
  // Back from the provider's hosted Checkout page (?checkout=success|cancelled); null while server-rendering.
  const checkout = useSyncExternalStore(
    noopSubscribe,
    () => new URLSearchParams(window.location.search).get('checkout'),
    () => null,
  );
  if (!access.isAdmin) return <NoAccess what={t('money.billing.noAccess')} />;
  if (sub.error) return <ErrorState error={sub.error} onRetry={sub.reload} />;
  if (!sub.data) return <Loading label={t('money.billing.loading')} />;

  const d = sub.data;
  const plan = PLANS[d.plan];
  const seatsText = seatsDraft ?? String(d.seats);
  const seats = Number(seatsText);
  const maxSeats = plan.max_billable_seats ?? 100_000;
  const minSeats = Math.min(d.billable_seats, maxSeats);
  const seatsValid = /^\d+$/.test(seatsText) && seats >= minSeats && seats <= maxSeats;
  const pricePerSeat = d.price_per_seat_cents;
  const paid = d.plan !== 'free' && d.status !== 'trialing';
  const annual = paid && d.billing_interval === 'year';
  // Plans are shown on the current term; before a paid plan, the annual price leads.
  const viewTerm: BillingInterval = term ?? (paid ? d.billing_interval : 'year');
  const annualTermEnd = annual && d.current_period_end && new Date(d.current_period_end) > new Date() ? d.current_period_end : null;
  const monthlyBlocked = viewTerm === 'month' && annualTermEnd !== null;
  const invoiceLabel = paid && d.billing_interval === 'year' ? t('money.billing.invoiceAnnual') : t('money.billing.invoiceMonth');

  const apply = async (target: PlanId, n: number, action: typeof seatAction, interval?: BillingInterval) => {
    const res = await action.run(() => rd.billing.changePlan(target, n, interval));
    if (res?.checkout_url) {
      // New paid subscriptions are paid for on the provider's hosted page; the webhook applies them.
      window.location.assign(res.checkout_url);
      return true;
    }
    const r = res?.subscription;
    if (r) {
      sub.mutate(() => r);
      setSeatsDraft(null);
      setSwitchTo(null);
      setSaved(tPlural(r.seats, 'money.billing.saved.one', 'money.billing.saved.other', { plan: r.plan_name }));
      reloadMe();
    }
    return !!r;
  };

  const target = switchTo ? PLANS[switchTo.plan] : null;
  const targetTerm = switchTo?.interval ?? 'month';
  const targetSeats = target ? Math.min(Math.max(d.seats, d.billable_seats), target.max_billable_seats ?? 100_000) : 0;
  const tooManyForTarget = !!target && target.max_billable_seats !== null && d.billable_seats > target.max_billable_seats;
  const losesScreenshots = !!target && d.entitlements.includes('screenshots') && !target.entitlements.includes('screenshots');
  const losesScopes = !!target && d.entitlements.includes('scoped_policies') && !target.entitlements.includes('scoped_policies');

  return (
    <>
      <PageHeader
        eyebrow={t('money.billing.eyebrow')}
        title={t('money.billing.title')}
        description={t('money.billing.description')}
      />
      <StatusBanner sub={d} tz={tz} />
      {checkout === 'success' ? (
        <Banner role="status" title={t('money.billing.paidTitle')}>
          {t('money.billing.paidBody')}
        </Banner>
      ) : checkout === 'cancelled' ? (
        <Banner role="status" title={t('money.billing.cancelledTitle')}>
          {t('money.billing.cancelledBody')}
        </Banner>
      ) : null}
      {saved ? (
        <Banner
          role="status"
          title={saved}
          actions={
            <Button size="sm" variant="quiet" onClick={() => setSaved(null)}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {t('money.billing.savedBody')}
        </Banner>
      ) : null}

      <div className={s.top}>
        <section className={s.planCard} aria-labelledby="plan-h">
          <span className={s.cardLabel}>{t('money.billing.currentPlan')}</span>
          <div className={s.planLine}>
            <h2 id="plan-h" className={s.planName}>
              {d.plan_name}
            </h2>
            <span className={s.planPrice}>{pricePerSeat === 0 ? t('money.billing.freeUpTo2') : seatPriceText(pricePerSeat, d.billing_interval)}</span>
          </div>
          <div className={s.status}>
            <span className={cx(s.statusDot, d.license !== 'active' && s.statusDotWarn)} aria-hidden="true" />
            {statusLine(d, tz)}
          </div>
          <div className={s.cost}>
            <span>{invoiceLabel}</span>
            <span className={s.costValue}>{formatMoney(d.estimated_invoice_cents)}</span>
          </div>
          <span className={s.fine}>
            {pricePerSeat === 0
              ? t('money.billing.noChargeFree')
              : t(d.billing_interval === 'year' ? 'money.billing.fineYear' : 'money.billing.fineMonth', {
                  seats: tPlural(Math.max(d.seats, d.billable_seats), 'money.billing.seatCount.one', 'money.billing.seatCount.other'),
                  price: price(pricePerSeat),
                })}
          </span>
          {d.billing_provider === 'stripe' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={portalAction.busy}
              onClick={async () => {
                const r = await portalAction.run(() => rd.billing.portal());
                if (r) window.location.assign(r.url);
              }}
            >
              {portalAction.busy ? t('money.billing.opening') : t('money.billing.portal')}
            </Button>
          ) : null}
          {d.cancel_at_period_end ? <span className={s.fine}>{t('money.billing.cancels')}</span> : null}
          <ActionError error={portalAction.error} />
        </section>

        <section className={s.seats} aria-labelledby="seats-h">
          <h2 id="seats-h">{t('money.billing.seats')}</h2>
          <SeatCells sub={d} />
          <dl className={s.stats}>
            <div className={s.stat}>
              <dt>{t('money.billing.tracked')}</dt>
              <dd>{d.billable_seats}</dd>
            </div>
            <div className={s.stat}>
              <dt>{t('money.billing.licensed')}</dt>
              <dd>{d.seats}</dd>
            </div>
            <div className={s.stat}>
              <dt>{t('money.billing.overage')}</dt>
              <dd>{plan.allows_overage ? `+${Math.max(0, d.seat_ceiling - d.seats)}` : '—'}</dd>
            </div>
            <div className={s.stat}>
              <dt>{t('money.billing.viewers')}</dt>
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
              {t('money.billing.licensedSeats')}
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
              {seatAction.busy ? t('money.billing.updating') : t('money.billing.updateSeats')}
            </Button>
            <span id="seats-hint" className="small secondary">
              {plan.max_billable_seats !== null
                ? t('money.billing.freeCovers', { n: plan.max_billable_seats })
                : t('money.billing.atLeast', { n: d.billable_seats })}
              {seatsValid && seats !== d.seats && pricePerSeat > 0
                ? ` ${t(d.billing_interval === 'year' ? 'money.billing.estimateYear' : 'money.billing.estimateMonth', {
                    amount: formatMoney(pricePerSeat * Math.max(seats, d.billable_seats) * (d.billing_interval === 'year' ? 12 : 1)),
                  })}`
                : ''}
            </span>
          </form>
          <ActionError error={seatAction.error} />
        </section>
      </div>

      <Card title={t('money.billing.plans')} subtitle={t('money.billing.plansSub')}>
        <div className={s.termRow}>
          <Segmented<BillingInterval>
            legend={t('money.billing.term')}
            name="term"
            value={viewTerm}
            onChange={setTerm}
            describedBy="term-hint"
            options={[
              { value: 'year', label: t('money.billing.termAnnual', { pct: formatPercent(annualSavingPercent('pro')) }) },
              { value: 'month', label: t('money.billing.termMonth') },
            ]}
          />
          <span id="term-hint" className="small secondary">
            {monthlyBlocked
              ? t('money.billing.termBlocked', { date: day(annualTermEnd, tz)! })
              : viewTerm === 'year'
                ? t('money.billing.termYearHint')
                : t('money.billing.termMonthHint')}
          </span>
        </div>
        <div className={s.plans}>
          {PLAN_IDS.map((id) => {
            const p = PLANS[id];
            const perMonth = p.prices[viewTerm];
            // Free has no term; a paid plan is "current" only on the term being shown.
            const current = id === d.plan && (id === 'free' || (paid && d.billing_interval === viewTerm));
            const samePlanOtherTerm = id === d.plan && id !== 'free' && paid && !current;
            const blocked = id !== 'free' && monthlyBlocked;
            return (
              <article key={id} className={cx(s.plan, current && s.planCurrent)} aria-labelledby={`plan-${id}`}>
                <div className={s.planHead}>
                  <h3 id={`plan-${id}`}>{p.name}</h3>
                  {current ? <span className={s.tag}>{t('money.billing.currentTag')}</span> : null}
                </div>
                <div className={s.price}>
                  <span className={s.priceValue}>{price(perMonth)}</span>
                  <span className="small muted">{p.max_billable_seats !== null ? t('money.billing.upTo', { n: p.max_billable_seats }) : t('money.billing.perUserMonth')}</span>
                </div>
                {perMonth > 0 ? (
                  <span className={s.priceTerm}>
                    {viewTerm === 'year'
                      ? t('money.billing.billedAnnually', { price: price(perMonth * 12) })
                      : t('money.billing.billedMonthly', { price: price(p.prices.year) })}
                  </span>
                ) : (
                  <span className={s.priceTerm}>{t('money.billing.noCard')}</span>
                )}
                <ul className={s.features}>
                  {PLAN_FEATURES[id].map((f) => (
                    <li key={f.key} className={f.on ? undefined : s.off}>
                      <span className={s.mark} aria-hidden="true">
                        {f.on ? '✓' : '–'}
                      </span>
                      <span>
                        {t(`money.billing.feat.${f.key}` as MessageKey)}
                        <span className="visually-hidden"> ({f.on ? t('money.billing.included') : t('money.billing.notIncluded')})</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {current ? (
                  <Button className={s.currentBtn} disabled aria-disabled="true">
                    {t('money.billing.currentPlan')}
                  </Button>
                ) : (
                  <Button className={s.planBtn} disabled={blocked} onClick={() => setSwitchTo({ plan: id, interval: viewTerm })}>
                    {samePlanOtherTerm
                      ? t(viewTerm === 'year' ? 'money.billing.switchAnnual' : 'money.billing.switchMonthly')
                      : t('money.billing.switchTo', { plan: p.name })}
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      </Card>

      <Card title={t('money.billing.failTitle')}>
        <p className="secondary">{t('money.billing.failBody')}</p>
      </Card>

      <Dialog
        open={switchTo !== null}
        onClose={() => {
          setSwitchTo(null);
          planAction.reset();
        }}
        title={
          target
            ? switchTo?.plan === d.plan
              ? t(targetTerm === 'year' ? 'money.billing.dialogAnnual' : 'money.billing.dialogMonthly')
              : t('money.billing.dialogPlan', { plan: target.name })
            : t('money.billing.dialogDefault')
        }
        footer={
          <>
            <Button onClick={() => setSwitchTo(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={planAction.busy || tooManyForTarget}
              onClick={() => switchTo && void apply(switchTo.plan, targetSeats, planAction, switchTo.plan === 'free' ? undefined : switchTo.interval)}
            >
              {planAction.busy ? t('money.billing.switching') : t('money.billing.confirm')}
            </Button>
          </>
        }
      >
        {target ? (
          <>
            <dl className={s.dlConfirm}>
              <dt>{t('money.billing.plan')}</dt>
              <dd>{target.name}</dd>
              <dt>{t('money.billing.price')}</dt>
              <dd>{target.id === 'free' ? price(0) : seatPriceText(target.prices[targetTerm], targetTerm)}</dd>
              <dt>{t('money.billing.licensedSeats')}</dt>
              <dd>{targetSeats}</dd>
              <dt>{target.id !== 'free' && targetTerm === 'year' ? t('money.billing.invoiceAnnual') : t('money.billing.estimatedMonthly')}</dt>
              <dd>{formatMoney(target.id === 'free' ? 0 : invoiceCents(target.id, targetTerm, Math.max(targetSeats, d.billable_seats)))}</dd>
            </dl>
            {target.id !== 'free' && targetTerm === 'year' ? (
              <p className="small secondary">{t('money.billing.annualNote')}</p>
            ) : null}
            {target.id === 'free' && annualTermEnd ? (
              <p className="small secondary">{t('money.billing.toFree', { date: day(annualTermEnd, tz)! })}</p>
            ) : null}
            {tooManyForTarget ? (
              <Banner tone="warn" role="alert" title={t('money.billing.tooManyTitle', { n: d.billable_seats, plan: target.name, max: target.max_billable_seats ?? 0 })}
              >
                {t('money.billing.tooManyBody', { n: d.billable_seats - (target.max_billable_seats ?? 0) })}
              </Banner>
            ) : null}
            {losesScreenshots || losesScopes ? (
              <Banner tone="warn" title={t('money.billing.lessTitle', { plan: target.name })}>
                {losesScreenshots ? `${t('money.billing.lessScreens')} ` : ''}
                {losesScopes ? `${t('money.billing.lessScopes')} ` : ''}
                {t('money.billing.lessNote')}
              </Banner>
            ) : null}
            <ActionError error={planAction.error} />
          </>
        ) : null}
      </Dialog>
    </>
  );
}
