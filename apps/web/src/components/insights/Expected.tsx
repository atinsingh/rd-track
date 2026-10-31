import type { ExpectedDay, ExpectedHours } from '@rd/contracts';
import { formatDuration, formatNumber } from '@/lib/format';
import { addDays, formatDayMonth, formatShortDay } from '@/lib/time';
import { t } from '@/lib/i18n';
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
      return e.schedule ? t('exp2.fromScheduleNamed', { name: e.schedule }) : t('exp2.fromSchedule');
    case 'work_limits':
      return t('exp2.fromLimits', { hours: hours((e.day_hours ?? 0) * 3600) });
    default:
      return t('exp2.fromStandard', { hours: hours((e.day_hours ?? 0) * 3600) });
  }
}

export function differenceText(e: ExpectedHours): string {
  const d = e.tracked_seconds - e.expected_seconds;
  if (e.expected_seconds === 0) return t('exp2.nothingExpected');
  if (Math.abs(d) < 60) return t('exp2.asExpected');
  return t(d < 0 ? 'exp2.under' : 'exp2.over', { time: formatDuration(Math.abs(d)) });
}

/** A bar up to the expected mark; time beyond it carries on past the mark in the same blue. */
export function ExpectedMeter({ e }: { e: ExpectedHours }) {
  const max = Math.max(e.expected_seconds, e.tracked_seconds, 1);
  const pct = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
  return (
    <span
      className={s.meter}
      role="img"
      aria-label={
        e.percent === null
          ? t('exp2.meter', { tracked: formatDuration(e.tracked_seconds), expected: formatDuration(e.expected_seconds) })
          : t('exp2.meterPct', { tracked: formatDuration(e.tracked_seconds), expected: formatDuration(e.expected_seconds), pct: e.percent })
      }
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
      sub: d.holiday ? t('exp2.holiday') : d.expected_seconds > 0 ? t('exp2.exp', { hours: hours(d.expected_seconds) }) : d.leave_seconds > 0 ? t('exp2.timeOff') : t('exp2.off'),
      tracked: d.tracked_seconds,
      focus: d.focus_seconds,
      expected: d.expected_seconds,
      title: `${t('exp2.dayTitle', { day: formatShortDay(d.date), tracked: formatDuration(d.tracked_seconds), expected: formatDuration(d.expected_seconds) })}${d.holiday ? t('exp2.dayHoliday', { name: d.holiday }) : ''}${d.leave_seconds ? t('exp2.dayLeave', { time: formatDuration(d.leave_seconds) }) : ''}`,
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
      sub: t('exp2.exp', { hours: hours(sum((d) => d.expected_seconds)) }),
      tracked: sum((d) => d.tracked_seconds),
      focus: sum((d) => d.focus_seconds),
      expected: sum((d) => d.expected_seconds),
      title: t('exp2.weekTitle', {
        from: formatDayMonth(from),
        to: formatDayMonth(addDays(from, 6)),
        tracked: formatDuration(sum((d) => d.tracked_seconds)),
        expected: formatDuration(sum((d) => d.expected_seconds)),
      }),
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
          {t('exp2.legendFocus')}
        </span>
        <span className={s.key}>
          <span className={s.swatchOther} aria-hidden="true" />
          {t('exp2.legendOther')}
        </span>
        <span className={s.key}>
          <span className={s.swatchExpected} aria-hidden="true" />
          {t('exp2.legendExpected')}
        </span>
      </div>
      <div className={s.chart} style={grid} role="img" aria-label={t(byWeek ? 'exp2.chartWeek' : 'exp2.chartDay', { cols: cols.map((c) => c.title).join('; ') })}>
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
      <p className={s.note}>
        {expectedSource(e)} {t('exp2.note')}
      </p>
    </>
  );
}

export { s as expectedStyles };
