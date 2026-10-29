import { EXPENSE_CATEGORY_LABELS, RECEIPT_CONTENT_TYPES, RECEIPT_MAX_BYTES, type ExpenseDTO, type MoneyTotal } from '@rd/contracts';
import { formatMoney, plural } from './format';
import { addDays, daysInMonth, formatDayMonth, startOfMonth } from './time';

/** How a claim's status reads in "Your claims" (Stage 4 F7). Never red: these are people's own claims. */
export interface ClaimStatus {
  label: string;
  /** `strong`: an outline badge with a dark edge (approved, not yet paid). */
  tone: 'outline' | 'strong' | 'solid' | 'warn';
  note: string | null;
}

const MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' });

/** "October payroll" for a whole calendar month, else "payroll 1 Oct – 15 Oct". */
export function payrollPeriodLabel(p: { from: string; to: string }): string {
  const wholeMonth = p.from === startOfMonth(p.from) && p.to === addDays(p.from, daysInMonth(p.from) - 1);
  if (wholeMonth) return `${MONTH.format(new Date(`${p.from}T00:00:00Z`))} payroll`;
  return `payroll ${formatDayMonth(p.from)} – ${formatDayMonth(p.to)}`;
}

function invoiceNote(e: ExpenseDTO): string | null {
  if (!e.invoice) return null;
  return e.invoice.number ? `on invoice ${e.invoice.number}` : 'on a draft invoice';
}

export function claimStatus(e: ExpenseDTO): ClaimStatus {
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  switch (e.status) {
    case 'pending':
      return { label: 'Waiting', tone: 'outline', note: null };
    case 'rejected': {
      const who = e.reviewed_by_name?.split(' ')[0];
      return { label: 'Sent back', tone: 'warn', note: e.review_note ? (who ? `${who}: ${e.review_note}` : e.review_note) : null };
    }
    case 'cancelled':
      return { label: 'Withdrawn', tone: 'outline', note: null };
    case 'approved': {
      if (e.reimbursed_period) {
        const period = payrollPeriodLabel(e.reimbursed_period);
        return { label: 'Paid', tone: 'solid', note: join(period[0]!.toUpperCase() + period.slice(1), invoiceNote(e)) };
      }
      return { label: 'Approved', tone: 'strong', note: join('Paid with the next payroll', invoiceNote(e)) };
    }
  }
}

/** "Meals · Client A · billable" */
export function claimMeta(e: ExpenseDTO): string {
  const where = e.billable && e.client_name ? e.client_name : (e.project_name ?? 'Internal');
  return [EXPENSE_CATEGORY_LABELS[e.category], where, e.billable ? 'billable' : null].filter(Boolean).join(' · ');
}

/** "£48.60" or "£48.60 + $12.00" across currencies; zero in `fallback` when empty. */
export function totalText(totals: readonly MoneyTotal[], fallback: string): string {
  if (!totals.length) return formatMoney(0, fallback);
  return totals.map((t) => formatMoney(t.cents, t.currency)).join(' + ');
}

export function totalCount(totals: readonly MoneyTotal[]): string {
  return plural(totals.reduce((n, t) => n + t.count, 0), 'claim');
}

export type ClaimRange = 'quarter' | 'year';

/** Where "Your claims" starts: the first of the month two months back, or 1 January. */
export function claimsFrom(range: ClaimRange, today: string): string {
  if (range === 'year') return `${today.slice(0, 4)}-01-01`;
  const [y, m] = today.split('-').map(Number) as [number, number];
  const back = m - 2 < 1 ? { y: y - 1, m: m + 10 } : { y, m: m - 2 };
  return `${back.y}-${String(back.m).padStart(2, '0')}-01`;
}

/** Why a receipt file can't be attached, or null when it can. */
export function receiptProblem(file: { type: string; size: number }): string | null {
  if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(file.type)) return 'Use a photo (JPEG, PNG, WebP or HEIC) or a PDF.';
  if (file.size > RECEIPT_MAX_BYTES) return 'That file is over 10 MB.';
  return null;
}
