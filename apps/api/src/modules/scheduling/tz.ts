/**
 * Calendar-day and time-zone arithmetic without a date library. Dates are `YYYY-MM-DD`
 * strings; instants are epoch milliseconds. Wall-clock → instant conversion goes through
 * Intl, so daylight-saving transitions are handled by the platform's tz database.
 */

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string) {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year!, mo: out.month!, d: out.day!, h: out.hour! % 24, mi: out.minute!, s: out.second! };
}

/** Offset of `tz` from UTC at instant `ms` (positive east of UTC). */
function offsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (ms - (ms % 1000));
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The instant of wall-clock `date hh:mm` in `tz`. A wall time skipped by DST maps to a nearby instant. */
export function zonedTimeToMs(date: string, time: string, tz: string): number {
  const [y, mo, d] = ymd(date);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h!, mi!);
  // Two passes settle the offset on either side of a transition.
  let t = wall - offsetMs(wall, tz);
  t = wall - offsetMs(t, tz);
  return t;
}

export function dateInTz(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday 1 (Mon) … 7 (Sun). */
export function isoWeekday(date: string): number {
  const [y, m, d] = ymd(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Inclusive list of dates from `from` to `to`. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysBetween(from: string, to: string): number {
  const [a, b, c] = ymd(from);
  const [x, y, z] = ymd(to);
  return Math.round((Date.UTC(x, y - 1, z) - Date.UTC(a, b - 1, c)) / DAY_MS);
}

/** Midnight UTC of a calendar date, for coarse range bounds. */
export function utcMidnight(date: string): number {
  const [y, m, d] = ymd(date);
  return Date.UTC(y, m - 1, d);
}
