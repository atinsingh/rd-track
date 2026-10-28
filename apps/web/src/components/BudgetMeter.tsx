import type { ProjectBudgetDTO } from '@rd/contracts';
import { Badge, Meter } from '@/components/ui/Layout';
import { formatDuration, formatMoney } from '@/lib/format';
import { BUDGET_STATUS_LABEL } from '@/lib/money';
import { formatDayMonth } from '@/lib/time';

/** Plain-language summary of a budget's usage (also the meter's accessible label). */
export function budgetSummary(b: ProjectBudgetDTO): string {
  const used = b.kind === 'hours' ? formatDuration(b.used_seconds) : formatMoney(b.used_cents ?? 0, b.currency ?? 'USD');
  const limit = b.kind === 'hours' ? formatDuration((b.limit_hours ?? 0) * 3600) : formatMoney(b.limit_cents ?? 0, b.currency ?? 'USD');
  const when = b.resets === 'monthly' ? ' this month' : '';
  return `${used} of ${limit} used${when} (${b.used_percent.toFixed(1)}%)`;
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
      : 'Since the project started';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="small secondary">
          {b.kind === 'hours' ? 'Hours budget' : `Amount budget (${b.currency})`} · {b.resets === 'monthly' ? 'resets monthly' : 'does not reset'} · {period}
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
        <strong style={{ fontFamily: 'var(--font-mono)' }}>{fmt(used)}</strong> of {fmt(limit)} used ({b.used_percent.toFixed(1)}%)
      </span>
      <span className="small muted">
        Alerts at {b.alert_thresholds.length ? b.alert_thresholds.map((t) => `${t}%`).join(', ') : 'no thresholds'}.{' '}
        {b.stop_at_budget
          ? 'At 100%, new sessions on this project can’t be started; sessions already running are never stopped.'
          : 'Tracking continues past the budget.'}
      </span>
      {b.kind === 'amount' && b.unrated_seconds > 0 ? (
        <span className="small muted">
          {formatDuration(b.unrated_seconds)} has no bill rate in {b.currency} and isn&apos;t counted.
        </span>
      ) : null}
    </div>
  );
}
