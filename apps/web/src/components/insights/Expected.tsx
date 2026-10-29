import type { ExpectedDay, ExpectedHours } from '@rd/contracts';
import { formatDuration, formatNumber } from '@/lib/format';
import { addDays, formatDayMonth, formatShortDay } from '@/lib/time';
import s from './expected.module.css';

/**
 * Expected hours (Stage 4 F6): what someone tracked against their schedule. Over and under
 * are information for the person, never a score, so neither is ever drawn in red.
 */

const hours = (sec: number) => {
  const h = Math.round((sec / 3600) * 10) / 10;
  return `${formatNumber(h, Number.isInteger(h) ? 0 : 1)}h`;
};

/** Where the expectation comes from, in one sentence. */
export function expectedSource(e: ExpectedHours): string {
  switch (e.source) {
    case 'schedule':
      return `Expected hours come from your schedule${e.schedule ? ` — ${e.schedule}` : ''}.`;
    case 'work_limits':
      return `Expected hours come from your work limits — ${hours((e.day_hours ?? 0) * 3600)} a weekday.`;
    default:
      return `Expected hours come from your organization's standard day — ${hours((e.day_hours ?? 0) * 3600)}, Monday to Friday.`;
  }
}

export function differenceText(e: ExpectedHours): string {
  const d = e.tracked_seconds - e.expected_seconds;
  if (e.expected_seconds === 0) return 'nothing expected';
  if (Math.abs(d) < 60) return 'as expected';
  return `${formatDuration(Math.abs(d))} ${d < 0 ? 'under' : 'over'}`;
}

/** A bar up to the expected mark; time beyond it carries on past the mark in the same blue. */
export function ExpectedMeter({ e }: { e: ExpectedHours }) {
  const max = Math.max(e.expected_seconds, e.tracked_seconds, 1);
  const pct = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
  return (
    <span
      className={s.meter}
      role="img"
      aria-label={`Tracked ${formatDuration(e.tracked_seconds)} of ${formatDuration(e.expected_seconds)} expected${e.percent === null ? '' : `, ${e.percent} percent`}`}
    >
      <span className={s.meterFill} style={{ width: pct(e.tracked_seconds) }} />
      {e.expected_seconds > 0 ? <span className={s.meterMark} style={{ left: pct(e.expected_seconds) }} /> : null}
    </span>
  );
}

interface Column {
  key: string;
  label: string;
  sub: string;
  tracked: number;
  focus: number;
  expected: number;
  title: string;
}

function columns(days: ExpectedDay[], byWeek: boolean): Column[] {
  if (!byWeek) {
    return days.map((d) => ({
      key: d.date,
      label: formatShortDay(d.date),
      sub: d.holiday ? 'holiday' : d.expected_seconds > 0 ? `exp ${hours(d.expected_seconds)}` : d.leave_seconds > 0 ? 'time off' : 'off',
      tracked: d.tracked_seconds,
      focus: d.focus_seconds,
      expected: d.expected_seconds,
      title: `${formatShortDay(d.date)}: ${formatDuration(d.tracked_seconds)} tracked, ${formatDuration(d.expected_seconds)} expected${d.holiday ? ` (${d.holiday})` : ''}${d.leave_seconds ? `, ${formatDuration(d.leave_seconds)} time off` : ''}`,
    }));
  }
  const out: Column[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    const sum = (f: (d: ExpectedDay) => number) => w.reduce((n, d) => n + f(d), 0);
    const from = w[0]!.date;
    out.push({
      key: from,
      label: formatDayMonth(from),
      sub: `exp ${hours(sum((d) => d.expected_seconds))}`,
      tracked: sum((d) => d.tracked_seconds),
      focus: sum((d) => d.focus_seconds),
      expected: sum((d) => d.expected_seconds),
      title: `Week of ${formatDayMonth(from)}–${formatDayMonth(addDays(from, 6))}: ${formatDuration(sum((d) => d.tracked_seconds))} tracked, ${formatDuration(sum((d) => d.expected_seconds))} expected`,
    });
  }
  return out;
}

/** Each day (or week) against the expected hours: focus and other tracked time, with a dashed expected line. */
export function ExpectedChart({ e, byWeek }: { e: ExpectedHours; byWeek: boolean }) {
  const cols = columns(e.days, byWeek);
  const max = Math.max(1, ...cols.map((c) => Math.max(c.tracked, c.expected))) * 1.05;
  const px = (sec: number) => Math.round((sec / max) * 200);
  const grid = { gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` };
  return (
    <>
      <div className={s.legend}>
        <span className={s.key}>
          <span className={s.swatchFocus} aria-hidden="true" />
          Focus blocks (30 min +)
        </span>
        <span className={s.key}>
          <span className={s.swatchOther} aria-hidden="true" />
          Other tracked time
        </span>
        <span className={s.key}>
          <span className={s.swatchExpected} aria-hidden="true" />
          Expected
        </span>
      </div>
      <div className={s.chart} style={grid} role="img" aria-label={`Tracked hours per ${byWeek ? 'week' : 'day'} with expected hours: ${cols.map((c) => c.title).join('; ')}`}>
        {cols.map((c) => (
          <div key={c.key} className={s.col} title={c.title}>
            <div className={s.stack}>
              <div className={s.other} style={{ height: px(Math.max(0, c.tracked - c.focus)) }} />
              <div className={s.focus} style={{ height: px(c.focus) }} />
            </div>
            {c.expected > 0 ? <span className={s.expected} style={{ bottom: px(c.expected) }} /> : null}
          </div>
        ))}
      </div>
      <div className={s.labels} style={grid} aria-hidden="true">
        {cols.map((c) => (
          <span key={c.key}>
            {c.label}
            <span className={s.total}>{c.tracked > 0 ? formatDuration(c.tracked) : '—'}</span>
            {c.sub}
          </span>
        ))}
      </div>
      <p className={s.note}>{expectedSource(e)} Time off and holidays lower them. Being over or under is information for you, not a score.</p>
    </>
  );
}

export { s as expectedStyles };
