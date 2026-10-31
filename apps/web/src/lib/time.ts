/**
 * Calendar and time-zone helpers without a date library. A "date" here is a
 * calendar day string `YYYY-MM-DD`; instants are epoch milliseconds or ISO strings.
 */

import { t } from './i18n';
import { currentLocale } from './locale';

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

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** A formatter in the current locale (G27), cached per locale, time zone and options. */
function fmt(tz: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = currentLocale();
  const key = `${locale}|${tz}|${JSON.stringify(o)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...o });
    fmtCache.set(key, f);
  }
  return f;
}

/** "Wed 28 Oct 2026" (en-GB), "Wed, Oct 28, 2026" (en-US), "mer. 28 oct. 2026" (fr) */
export function formatDayLabel(date: string): string {
  return fmt('UTC', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(calendarDate(date));
}

/** "Wed 28 Oct" */
export function formatShortDay(date: string): string {
  return fmt('UTC', { weekday: 'short', day: 'numeric', month: 'short' }).format(calendarDate(date));
}

/** "26 Oct" */
export function formatDayMonth(date: string): string {
  return fmt('UTC', { day: 'numeric', month: 'short' }).format(calendarDate(date));
}

/** "October 2026" */
export function formatMonthYear(date: string): string {
  return fmt('UTC', { month: 'long', year: 'numeric' }).format(calendarDate(date));
}

/** "October" */
export function formatMonth(date: string): string {
  return fmt('UTC', { month: 'long' }).format(calendarDate(date));
}

/** A weekday's short name, ISO numbering (1 = Monday). */
export function weekdayShort(isoDay: number): string {
  // 2026-01-05 was a Monday.
  return fmt('UTC', { weekday: 'short' }).format(calendarDate(addDays('2026-01-05', isoDay - 1)));
}

/** "08:12" or "8:12 AM" in `tz`, as the locale writes times. */
export function formatTime(iso: string | number, tz: string): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  // Two-digit hours where the clock is 24-hour ("08:12"), as the locale has them otherwise ("8:12 AM").
  const h24 = fmt(tz, { hour: 'numeric' }).resolvedOptions().hourCycle === 'h23';
  return fmt(tz, { hour: h24 ? '2-digit' : 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** An hour on a chart axis: "09" on a 24-hour clock, "9 AM" on a 12-hour one. */
export function formatHour(ms: number, tz: string): string {
  const h24 = fmt(tz, { hour: 'numeric' }).resolvedOptions().hourCycle === 'h23';
  return h24 ? String(zonedParts(ms, tz).hour).padStart(2, '0') : fmt(tz, { hour: 'numeric' }).format(new Date(ms));
}

/** "27 Oct 2026, 16:40" in `tz`. */
export function formatDateTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const h24 = fmt(tz, { hour: 'numeric' }).resolvedOptions().hourCycle === 'h23';
  return fmt(tz, { day: 'numeric', month: 'short', year: 'numeric', hour: h24 ? '2-digit' : 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** "08:12", 24-hour, for time inputs (never localized). */
function inputTime(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Local `{date, time}` of an instant, for prefilling date/time inputs. */
export function toZonedInputs(iso: string, tz: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  return { date: dateInTz(ms, tz), time: inputTime(ms, tz) };
}

/** "3 min ago", "Yesterday 17:58", "12 Oct 2026, 09:00" */
export function formatRelative(iso: string | null | undefined, tz: string, now: number = Date.now()): string {
  if (!iso) return t('time.never');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diff = now - ms;
  if (diff >= 0 && diff < MINUTE) return t('time.justNow');
  if (diff >= 0 && diff < 60 * MINUTE) return new Intl.RelativeTimeFormat(currentLocale(), { style: 'short' }).format(-Math.floor(diff / MINUTE), 'minute');
  const today = dateInTz(now, tz);
  const day = dateInTz(ms, tz);
  if (day === today) return t('time.todayAt', { time: formatTime(ms, tz) });
  if (day === addDays(today, -1)) return t('time.yesterdayAt', { time: formatTime(ms, tz) });
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

/** Monday to Sunday, short, in the current locale. */
export const weekdaysShort = (): string[] => [1, 2, 3, 4, 5, 6, 7].map(weekdayShort);
