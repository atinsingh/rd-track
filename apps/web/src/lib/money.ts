import type { BudgetStatus, InvoiceStatus } from '@rd/contracts';
import { formatMoney } from './format';

/** Common ISO 4217 codes offered in pickers; the API accepts any three-letter code. */
export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'SGD', 'ZAR'] as const;

/** "12.5" / "12.50" / "1,200.00" → cents; null when not a valid non-negative amount with ≤ 2 decimals. */
export function parseMoneyInput(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "1.5" → 1.5 hours; null unless a non-negative number with ≤ 2 decimals. */
export function parseHoursInput(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/** "80, 100" → [80, 100]; null if any entry is not a whole percentage between 1 and 1000. */
export function parseThresholds(raw: string): number[] | null {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.replace(/%$/, ''))
    .filter(Boolean);
  if (parts.length > 10) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) return null;
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** Tax in basis points from a percentage input ("8.25" → 825). */
export function parsePercentBp(raw: string): number | null {
  const s = raw.trim().replace(/%$/, '');
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp <= 10_000 ? bp : null;
}

export function formatPercentBp(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}

export function formatRate(cents: number, currency: string): string {
  return `${formatMoney(cents, currency)}/h`;
}

export function formatHours(hours: number): string {
  return `${hours.toFixed(2)} h`;
}

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = { draft: 'Draft', issued: 'Issued', void: 'Void' };

/** Budget wording. Status is about a project's budget, never about a person. */
export const BUDGET_STATUS_LABEL: Record<BudgetStatus, string> = {
  ok: 'Within budget',
  near: 'Near budget',
  reached: 'Budget reached',
};

/** Latest rate per key (rows are newest-first per key). */
export function latestBy<T extends { effective_from: string }>(rows: readonly T[], key: (r: T) => string, today: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of [...rows].sort((a, b) => b.effective_from.localeCompare(a.effective_from))) {
    if (r.effective_from > today) continue;
    const k = key(r);
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}
