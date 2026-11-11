import type { BudgetStatus, InvoiceStatus, PayrollAdjustmentDTO } from '@rd/contracts';
import type { InvoiceState } from './workspaces';
import { formatMoney, formatNumber, formatPercent } from './format';
import { t } from './i18n';
import { currentLocale } from './locale';
import { formatDayLabel } from './time';

/** Common ISO 4217 codes offered in pickers; the API accepts any three-letter code. */
export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'SGD', 'ZAR'] as const;

/** Whether the locale writes 1.5 as "1,5". */
const commaDecimal = (locale: string = currentLocale()) => new Intl.NumberFormat(locale).format(1.5).includes(',');

/**
 * A typed decimal in the locale's way → "1234.5" for the callers' checks. Spaces (thin,
 * non-breaking) are digit groups everywhere; a comma is the decimal mark where the locale
 * uses one, else a thousands group. A point is always accepted as the decimal mark, since
 * keypads type one.
 */
export function normalizeDecimal(raw: string, locale: string = currentLocale()): string {
  const s = raw.trim().replace(/[\s\u00a0\u202f]/g, '');
  // "1,200.50": commas only where they group thousands, so "1,5" stays invalid rather than 15.
  if (!commaDecimal(locale)) return /^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s) ? s.replace(/,/g, '') : s;
  return s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s;
}

/** "12.5" / "12.50" / "1,200.00" ("12,5" / "1 200,00" in French) → cents; null when not a valid non-negative amount with ≤ 2 decimals. */
export function parseMoneyInput(raw: string): number | null {
  const s = normalizeDecimal(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** A number as the locale types it into a field, without digit groups: "1200.50" or "1200,50". */
export function decimalToInput(n: number, decimals: number): string {
  const v = n.toFixed(decimals);
  return commaDecimal() ? v.replace('.', ',') : v;
}

export const centsToInput = (cents: number): string => decimalToInput(cents / 100, 2);

/** "1.5" → 1.5 hours; null unless a non-negative number with ≤ 2 decimals. */
export function parseHoursInput(raw: string): number | null {
  const s = normalizeDecimal(raw);
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
  const s = normalizeDecimal(raw.trim().replace(/\s*%$/, ''));
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp <= 10_000 ? bp : null;
}

export function formatPercentBp(bp: number): string {
  return formatPercent(bp / 100, bp % 100 === 0 ? 0 : 2);
}

export function formatRate(cents: number, currency: string): string {
  return t('money.perHour', { amount: formatMoney(cents, currency) });
}

export function formatHours(hours: number): string {
  return `${formatNumber(hours, 2)} h`;
}

/** Read in the current language each time (G27). */
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  get draft() {
    return t('money.invoiceStatus.draft');
  },
  get issued() {
    return t('money.invoiceStatus.issued');
  },
  get void() {
    return t('money.invoiceStatus.void');
  },
};

/** Budget wording. Status is about a project's budget, never about a person. */
export const BUDGET_STATUS_LABEL: Record<BudgetStatus, string> = {
  get ok() {
    return t('money.budgetStatus.ok');
  },
  get near() {
    return t('money.budgetStatus.near');
  },
  get reached() {
    return t('money.budgetStatus.reached');
  },
};

/** An invoice's state (draft, unpaid, overdue, paid, void), in the current language. */
export const invoiceStateLabel = (state: InvoiceState): string => t(`money.invoiceState.${state}`);

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

/** "Once, in the pay period with Thu 15 Oct 2026" / "Every pay period from Tue 1 Sep 2026 until Sat 31 Oct 2026" (F8). */
export function adjustmentWhen(a: Pick<PayrollAdjustmentDTO, 'recurrence' | 'effective_from' | 'effective_to'>): string {
  if (a.recurrence === 'once') return t('pay.once', { date: formatDayLabel(a.effective_from) });
  return `${t('pay.every', { date: formatDayLabel(a.effective_from) })}${a.effective_to ? t('pay.until', { date: formatDayLabel(a.effective_to) }) : ''}`;
}

