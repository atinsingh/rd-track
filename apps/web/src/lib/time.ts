/**
 * Calendar and time-zone helpers without a date library. A "date" here is a
 * calendar day string `YYYY-MM-DD`; instants are epoch milliseconds or ISO strings.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
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
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (positive east of UTC). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The UTC instant of local wall time `date hh:mm` in `tz`. */
export function zonedTimeToMs(date: string, time: string, tz: string): number {
  const [y, mo, d] = parseDate(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!tm) throw new Error(`Invalid time: ${time}`);
  const wall = Date.UTC(y, mo - 1, d, Number(tm[1]), Number(tm[2]));
  // Two passes settle the offset across DST transitions.
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

export function zonedMidnightMs(date: string, tz: string): number {
  return zonedTimeToMs(date, '00:00', tz);
}

export interface DayRange {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

/** [local midnight, next local midnight) for `date` in `tz`. */
export function dayRange(date: string, tz: string): DayRange {
  const fromMs = zonedMidnightMs(date, tz);
  const toMs = zonedMidnightMs(addDays(date, 1), tz);
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs };
}

/** [local midnight of `start`, local midnight of `start + days`). */
export function daysRange(start: string, days: number, tz: string): DayRange {
  const fromMs = zonedMidnightMs(start, tz);
  const toMs = zonedMidnightMs(addDays(start, days), tz);
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs };
}

export function toDateString(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function dateInTz(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return toDateString(p.year, p.month, p.day);
}

export function todayInTz(tz: string, now: number = Date.now()): string {
  return dateInTz(now, tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
  return toDateString(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** ISO weekday 1 (Mon) … 7 (Sun) of a calendar date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parseDate(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function startOfWeek(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function startOfMonth(date: string): string {
  const [y, m] = parseDate(date);
  return toDateString(y, m, 1);
}

export function daysInMonth(date: string): number {
  const [y, m] = parseDate(date);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function calendarDate(date: string): Date {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function dayParts(date: string): { weekday: string; day: string; month: string; year: string } {
  const out = { weekday: '', day: '', month: '', year: '' };
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  for (const p of f.formatToParts(calendarDate(date))) {
    if (p.type === 'weekday' || p.type === 'day' || p.type === 'month' || p.type === 'year') out[p.type] = p.value;
  }
  return out;
}

/** "Wed 28 Oct 2026" */
export function formatDayLabel(date: string): string {
  const p = dayParts(date);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** "Wed 28 Oct" */
export function formatShortDay(date: string): string {
  const p = dayParts(date);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "26 Oct" */
export function formatDayMonth(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(
    calendarDate(date),
  );
}

/** "08:12" in `tz`. */
export function formatTime(iso: string | number, tz: string): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const p = zonedParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** "27 Oct 2026, 16:40" in `tz`. */
export function formatDateTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const p = zonedParts(ms, tz);
  return `${formatDayMonth(toDateString(p.year, p.month, p.day))} ${p.year}, ${formatTime(ms, tz)}`;
}

/** Local `{date, time}` of an instant, for prefilling date/time inputs. */
export function toZonedInputs(iso: string, tz: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  return { date: dateInTz(ms, tz), time: formatTime(ms, tz) };
}

/** "3 min ago", "Yesterday 17:58", "12 Oct 2026, 09:00" */
export function formatRelative(iso: string | null | undefined, tz: string, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diff = now - ms;
  if (diff >= 0 && diff < MINUTE) return 'just now';
  if (diff >= 0 && diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} min ago`;
  const today = dateInTz(now, tz);
  const day = dateInTz(ms, tz);
  if (day === today) return `Today ${formatTime(ms, tz)}`;
  if (day === addDays(today, -1)) return `Yesterday ${formatTime(ms, tz)}`;
  return formatDateTime(iso, tz);
}

/** "mm:ss" countdown to an expiry. */
export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timeZoneOptions(...extra: string[]): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const set = new Set<string>(['UTC', ...zones]);
  for (const z of extra) if (z && isValidTimeZone(z)) set.add(z);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
