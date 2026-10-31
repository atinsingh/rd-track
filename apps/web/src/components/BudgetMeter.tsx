import type { ProjectBudgetDTO } from '@rd/contracts';
import { Badge, Meter } from '@/components/ui/Layout';
import { formatDuration, formatMoney, formatPercent } from '@/lib/format';
import { BUDGET_STATUS_LABEL } from '@/lib/money';
import { formatDayMonth } from '@/lib/time';
import { t } from '@/lib/i18n';

/** Plain-language summary of a budget's usage (also the meter's accessible label). */
export function budgetSummary(b: ProjectBudgetDTO): string {
  const used = b.kind === 'hours' ? formatDuration(b.used_seconds) : formatMoney(b.used_cents ?? 0, b.currency ?? 'USD');
  const limit = b.kind === 'hours' ? formatDuration((b.limit_hours ?? 0) * 3600) : formatMoney(b.limit_cents ?? 0, b.currency ?? 'USD');
  return t(b.resets === 'monthly' ? 'money.budget.summaryMonth' : 'money.budget.summary', { used, limit, pct: formatPercent(b.used_percent, 1) });
}

/**
 * A project's budget: progress in neutral ink; amber appears only as the "near / reached"
 * warning badge. Budget status describes a project, never a person.
 */
export function BudgetMeter({ budget: b }: { budget: ProjectBudgetDTO }) {
  const used = b.kind === 'hours' ? b.used_seconds : (b.used_cents ?? 0);
  const limit = b.kind === 'hours' ? (b.limit_hours ?? 0) * 3600 : (b.limit_cents ?? 0);
  const over = used > limit;
  const fmt = (n: number) => (b.kind === 'hours' ? formatDuration(n) : formatMoney(n, b.currency ?? 'USD'));
  const period =
    b.resets === 'monthly' && b.period.from && b.period.to
      ? `${formatDayMonth(b.period.from.slice(0, 10))} – ${formatDayMonth(new Date(Date.parse(b.period.to) - 86_400_000).toISOString().slice(0, 10))}`
      : t('money.budget.sinceStart');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="small secondary">
          {b.kind === 'hours' ? t('money.budget.hours') : t('money.budget.amount', { currency: b.currency ?? '' })} ·{' '}
          {b.resets === 'monthly' ? t('money.budget.resetsMonthly') : t('money.budget.noReset')} · {period}
        </span>
        <Badge tone={b.status === 'ok' ? 'outline' : 'warn'}>{BUDGET_STATUS_LABEL[b.status]}</Badge>
      </div>
      <Meter
        value={used}
        max={Math.max(limit, used)}
        mark={over ? limit : undefined}
        label={budgetSummary(b)}
        scale={['0', over ? fmt(used) : fmt(limit)]}
      />
      <span>
        <strong style={{ fontFamily: 'var(--font-mono)' }}>{fmt(used)}</strong> {t('money.budget.ofUsed', { limit: fmt(limit), pct: formatPercent(b.used_percent, 1) })}
      </span>
      <span className="small muted">
        {t('money.budget.alertsAt', { list: b.alert_thresholds.length ? b.alert_thresholds.map((x) => formatPercent(x)).join(', ') : t('money.budget.noThresholds') })}{' '}
        {b.stop_at_budget ? t('money.budget.stops') : t('money.budget.continues')}
      </span>
      {b.kind === 'amount' && b.unrated_seconds > 0 ? (
        <span className="small muted">
          {t('money.budget.unrated', { duration: formatDuration(b.unrated_seconds), currency: b.currency ?? '' })}
        </span>
      ) : null}
    </div>
  );
}
