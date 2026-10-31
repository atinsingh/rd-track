import { formatDuration } from '@rd/contracts';
import { currentLocale } from './locale';

export { formatDuration };

/** Duration, or an em dash for zero/absent values (tables). */
export function durationOrDash(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds <= 0) return '—';
  return formatDuration(seconds);
}

const numCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, o: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(o)}`;
  let f = numCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, o);
    numCache.set(key, f);
  }
  return f;
}

/** A number as the current locale writes it: "1,234.5" or "1 234,5". `decimals` fixes the digits after the point. */
export function formatNumber(n: number, decimals?: number, locale: string = currentLocale()): string {
  return nf(locale, decimals === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
}

/** Compact hours for chart labels: "36h", "7.5h", "45m". */
export function formatHoursShort(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = s / 3600;
  const rounded = Math.round(h * 10) / 10;
  return `${formatNumber(rounded, Number.isInteger(rounded) ? 0 : 1)}h`;
}

/** "42%" or "42 %". `decimals` digits after the point (default none). */
export function formatPercent(p: number, decimals = 0, locale: string = currentLocale()): string {
  return nf(locale, { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(p / 100);
}

export function percentOrDash(p: number | null | undefined): string {
  return p === null || p === undefined ? '—' : formatPercent(Math.round(p));
}

/** Money in the current locale, or in `locale` for a document written in someone else's (an invoice). */
export function formatMoney(cents: number, currency = 'USD', locale: string = currentLocale()): string {
  return nf(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
}

/** Like formatMoney, without cents when there are none: "$5", "$2.50". */
export function formatPrice(cents: number, currency = 'USD', locale: string = currentLocale()): string {
  return cents % 100 === 0 ? nf(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(cents / 100) : formatMoney(cents, currency, locale);
}

/** "340 KB", "1.2 MB" */
export function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${formatNumber(Math.max(1, Math.round(n / 1024)), 0)} KB` : `${formatNumber(n / 1024 / 1024, 1)} MB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function byName<T extends { display_name: string }>(a: T, b: T): number {
  return a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' });
}

export function humanize(code: string): string {
  const s = code.replace(/[._]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}
