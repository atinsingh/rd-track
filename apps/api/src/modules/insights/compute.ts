import {
  BREAKLESS_STRETCH_SECONDS,
  FOCUS_MIN_MINUTES,
  LONG_DAY_SECONDS,
  TYPICAL_DAY_MIN_SECONDS,
  type DayInsight,
  type TypicalDay,
} from '@rd/contracts';

/**
 * Pure insight computation over minute buckets (system design §6.3 data). Exported for
 * unit tests; the service feeds it rows from Postgres.
 */

export interface InsightBucket {
  session_id: string;
  bucket_start: string;
  active_seconds: number;
  idle_seconds: number;
  data_quality: 'ok' | 'partial' | 'permission_missing';
}

/** A minute counts towards focus when the person was active for at least a third of it. */
const ENGAGED_ACTIVE_SECONDS = 20;
/** Up to this many quieter minutes (reading, thinking) don't break a focus block. */
const FOCUS_TOLERANCE_MINUTES = 2;
/** Gaps shorter than this between tracked minutes don't count as a break. */
const BREAK_MIN_MINUTES = 10;

export interface LocalClock {
  date: string; // YYYY-MM-DD in the person's time zone
  minuteOfDay: number;
  weekday: number; // ISO 1 = Monday … 7 = Sunday
}

export function localClock(tz: string): (iso: string) => LocalClock {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const days: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return (iso) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
      weekday: days[parts.weekday as string] ?? 1,
    };
  };
}

function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface FocusBlock {
  session_id: string;
  start: string;
  minutes: number;
}

/** Focus blocks: ≥ 30 consecutive minutes in one session, engaged with small tolerance. */
export function focusBlocks(buckets: readonly InsightBucket[]): FocusBlock[] {
  const sorted = [...buckets].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
  const blocks: FocusBlock[] = [];
  let start: InsightBucket | null = null;
  let lastEngagedIdx = -1;
  let quiet = 0;

  const close = (i: number) => {
    if (start && lastEngagedIdx >= 0) {
      const first = new Date(start.bucket_start).getTime();
      const last = new Date(sorted[lastEngagedIdx]!.bucket_start).getTime();
      const minutes = Math.round((last - first) / 60_000) + 1;
      if (minutes >= FOCUS_MIN_MINUTES) blocks.push({ session_id: start.session_id, start: start.bucket_start, minutes });
    }
    start = null;
    lastEngagedIdx = -1;
    quiet = 0;
    void i;
  };

  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    const prev = sorted[i - 1];
    const contiguous =
      prev && prev.session_id === b.session_id && new Date(b.bucket_start).getTime() - new Date(prev.bucket_start).getTime() === 60_000;
    if (start && !contiguous) close(i);
    const engaged = b.data_quality !== 'permission_missing' && b.active_seconds >= ENGAGED_ACTIVE_SECONDS;
    if (engaged) {
      if (!start) start = b;
      lastEngagedIdx = i;
      quiet = 0;
    } else if (start) {
      quiet++;
      if (quiet > FOCUS_TOLERANCE_MINUTES) close(i);
    }
  }
  close(sorted.length);
  return blocks;
}

/** Per local day: tracked, after-hours, longest stretch without a ≥ 10 min break, focus. */
export function dailyInsights(
  buckets: readonly InsightBucket[],
  tz: string,
  workingHours: { start: string; end: string },
): DayInsight[] {
  const clock = localClock(tz);
  const startMin = hhmm(workingHours.start);
  const endMin = hhmm(workingHours.end);
  const sorted = [...buckets].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
  const byDay = new Map<string, DayInsight & { _lastTs: number; _stretchStart: number; _first: number; _last: number }>();

  for (const b of sorted) {
    const c = clock(b.bucket_start);
    const ts = new Date(b.bucket_start).getTime();
    let d = byDay.get(c.date);
    if (!d) {
      d = {
        date: c.date,
        tracked_seconds: 0,
        focus_seconds: 0,
        focus_blocks: 0,
        after_hours_seconds: 0,
        weekend: c.weekday >= 6,
        longest_stretch_seconds: 0,
        long_day: false,
        first_start: '',
        last_stop: '',
        idle_seconds: 0,
        _lastTs: -Infinity,
        _stretchStart: ts,
        _first: c.minuteOfDay,
        _last: c.minuteOfDay,
      };
      byDay.set(c.date, d);
    }
    const seconds = b.active_seconds + b.idle_seconds;
    d.tracked_seconds += seconds;
    d.idle_seconds += b.idle_seconds;
    d._first = Math.min(d._first, c.minuteOfDay);
    d._last = Math.max(d._last, c.minuteOfDay);
    if (c.weekday < 6 && (c.minuteOfDay < startMin || c.minuteOfDay >= endMin)) d.after_hours_seconds += seconds;
    if (ts - d._lastTs > BREAK_MIN_MINUTES * 60_000) d._stretchStart = ts;
    d.longest_stretch_seconds = Math.max(d.longest_stretch_seconds, (ts - d._stretchStart) / 1000 + 60);
    d._lastTs = ts;
  }
  for (const block of focusBlocks(sorted)) {
    const d = byDay.get(clock(block.start).date);
    if (d) {
      d.focus_seconds += block.minutes * 60;
      d.focus_blocks++;
    }
  }
  return [...byDay.values()]
    .map(({ _lastTs: _l, _stretchStart: _s, _first, _last, ...d }) => ({
      ...d,
      long_day: d.tracked_seconds > LONG_DAY_SECONDS,
      first_start: clockText(_first),
      last_stop: clockText(Math.min(_last + 1, 24 * 60)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function clockText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Average first start, last stop and idle time over the days with at least half an hour tracked. */
export function typicalDay(days: readonly DayInsight[]): TypicalDay {
  const worked = days.filter((d) => d.tracked_seconds >= TYPICAL_DAY_MIN_SECONDS);
  if (worked.length === 0) return { days: 0, start: null, stop: null, idle_seconds: null };
  const avg = (f: (d: DayInsight) => number) => worked.reduce((n, d) => n + f(d), 0) / worked.length;
  return {
    days: worked.length,
    start: clockText(Math.round(avg((d) => hhmm(d.first_start)))),
    stop: clockText(Math.round(avg((d) => hhmm(d.last_stop)))),
    idle_seconds: Math.round(avg((d) => d.idle_seconds)),
  };
}

export function summarize(days: readonly DayInsight[]) {
  const sum = (f: (d: DayInsight) => number) => days.reduce((n, d) => n + f(d), 0);
  const tracked = sum((d) => d.tracked_seconds);
  const focus = sum((d) => d.focus_seconds);
  return {
    tracked_seconds: tracked,
    focus_seconds: focus,
    focus_blocks: sum((d) => d.focus_blocks),
    focus_share_percent: tracked > 0 ? Math.round((focus / tracked) * 100) : null,
    after_hours_seconds: sum((d) => d.after_hours_seconds),
    weekend_seconds: sum((d) => (d.weekend ? d.tracked_seconds : 0)),
    long_days: days.filter((d) => d.long_day).length,
    breakless_days: days.filter((d) => d.longest_stretch_seconds > BREAKLESS_STRETCH_SECONDS).length,
    longest_stretch_seconds: Math.max(0, ...days.map((d) => d.longest_stretch_seconds)),
  };
}
