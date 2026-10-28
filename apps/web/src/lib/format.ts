import { formatDuration } from '@rd/contracts';

export { formatDuration };

/** Duration, or an em dash for zero/absent values (tables). */
export function durationOrDash(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds <= 0) return '—';
  return formatDuration(seconds);
}

/** Compact hours for chart labels: "36h", "7.5h", "45m". */
export function formatHoursShort(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = s / 3600;
  const rounded = Math.round(h * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}h`;
}

export function percentOrDash(p: number | null | undefined): string {
  return p === null || p === undefined ? '—' : `${Math.round(p)}%`;
}

export function formatMoney(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
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
