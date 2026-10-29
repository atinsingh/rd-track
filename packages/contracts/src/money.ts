import { z } from 'zod';
import { uuid } from './events';

/**
 * Stage 3 "Money": clients, pay and bill rates, project budgets, invoices and payroll
 * export (competitive gap analysis, Stage 3 item 2). Pro plan (`budgets_invoicing`).
 *
 * Money is integer cents in an ISO-4217 currency. Rounding rule (used everywhere hours
 * become money — invoices, amount budgets, payroll):
 *   1. sum the seconds of one line (one project / person / rate),
 *   2. round to the nearest whole minute (half up),
 *   3. convert to hours with two decimals (half up),
 *   4. amount = hours × hourly rate in cents, rounded to the cent (half up),
 *   5. tax = subtotal × tax_rate_bp / 10 000, rounded to the cent (half up).
 */

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter ISO 4217 code, e.g. USD');
export const isoDate = z.iso.date();
/** Hourly amounts up to 100 000.00 in any currency. */
export const hourlyCents = z.number().int().min(0).max(10_000_000);

// ───────────────────────── rounding ─────────────────────────

/** Hours × 100 (integer) for a number of seconds: minute rounding, then two decimals. */
export function billableCentiHours(seconds: number): number {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  return Math.round((minutes * 100) / 60);
}

/** Hours with two decimals for a number of seconds (see the rounding rule above). */
export function billableHours(seconds: number): number {
  return billableCentiHours(seconds) / 100;
}

/** Amount in cents for hours (two decimals) at an hourly rate in cents. */
export function lineAmountCents(hours: number, rateCents: number): number {
  const centiHours = Math.round(hours * 100);
  return Math.round((centiHours * rateCents) / 100);
}

/** Tax in cents on a subtotal at a rate in basis points (1 bp = 0.01 %). */
export function taxCents(subtotalCents: number, taxRateBp: number): number {
  return Math.round((subtotalCents * taxRateBp) / 10_000);
}

export function invoiceTotals(lineAmounts: readonly number[], taxRateBp: number) {
  const subtotal_cents = lineAmounts.reduce((a, b) => a + b, 0);
  const tax_cents = taxCents(subtotal_cents, taxRateBp);
  return { subtotal_cents, tax_cents, total_cents: subtotal_cents + tax_cents };
}

// ───────────────────────── clients ─────────────────────────

export const clientCreateRequest = z.strictObject({
  name: z.string().trim().min(1).max(200),
  contact_email: z.email().max(320).nullable().optional(),
  currency: currencyCode.default('USD'),
  address: z.string().max(2000).nullable().optional(),
});
export const clientUpdateRequest = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  contact_email: z.email().max(320).nullable().optional(),
  currency: currencyCode.optional(),
  address: z.string().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});
export interface ClientDTO {
  id: string;
  name: string;
  contact_email: string | null;
  currency: string;
  address: string | null;
  archived: boolean;
  created_at: string;
  projects: { id: string; name: string }[];
}
/** `PUT /v1/admin/projects/{id}/client` */
export const projectClientRequest = z.strictObject({ client_id: uuid.nullable() });

// ───────────────────────── rates ─────────────────────────

export const payRateCreateRequest = z.strictObject({
  user_id: uuid,
  amount_cents: hourlyCents,
  currency: currencyCode.default('USD'),
  effective_from: isoDate,
});
export interface PayRateDTO {
  id: string;
  user_id: string;
  user_name: string;
  amount_cents: number;
  currency: string;
  effective_from: string;
  created_at: string;
}

export const billRateCreateRequest = z.strictObject({
  project_id: uuid,
  /** null or omitted = the project's default rate */
  user_id: uuid.nullable().optional(),
  amount_cents: hourlyCents,
  currency: currencyCode.default('USD'),
  effective_from: isoDate,
});
export interface BillRateDTO {
  id: string;
  project_id: string;
  project_name: string;
  user_id: string | null;
  user_name: string | null;
  amount_cents: number;
  currency: string;
  effective_from: string;
  created_at: string;
}

/** `GET /v1/me/pay-rate`: the employee's own rate only. */
export interface MyPayRateResponse {
  current: { amount_cents: number; currency: string; effective_from: string } | null;
  upcoming: { amount_cents: number; currency: string; effective_from: string } | null;
}

// ───────────────────────── budgets ─────────────────────────

export const BUDGET_KINDS = ['hours', 'amount'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];
export const BUDGET_RESETS = ['monthly', 'never'] as const;
export type BudgetResets = (typeof BUDGET_RESETS)[number];

export const projectBudgetRequest = z
  .strictObject({
    kind: z.enum(BUDGET_KINDS),
    /** hours budgets: limit in hours (two decimals) */
    limit_hours: z.number().positive().max(1_000_000).multipleOf(0.01).optional(),
    /** amount budgets: limit in cents of `currency` */
    limit_cents: z.number().int().positive().max(100_000_000_000).optional(),
    currency: currencyCode.optional(),
    alert_thresholds: z.array(z.number().int().min(1).max(1000)).max(10).default([80, 100]),
    stop_at_budget: z.boolean().default(false),
    resets: z.enum(BUDGET_RESETS).default('never'),
  })
  .refine((b) => (b.kind === 'hours' ? b.limit_hours !== undefined : b.limit_cents !== undefined && b.currency !== undefined), {
    message: 'Hours budgets need limit_hours; amount budgets need limit_cents and currency',
  });

export type BudgetStatus = 'ok' | 'near' | 'reached';
export interface ProjectBudgetDTO {
  project_id: string;
  project_name: string;
  kind: BudgetKind;
  limit_hours: number | null;
  limit_cents: number | null;
  currency: string | null;
  alert_thresholds: number[];
  stop_at_budget: boolean;
  resets: BudgetResets;
  /** Current budget period: a calendar month (UTC) or everything since the start. */
  period: { key: string; from: string | null; to: string | null };
  used_seconds: number;
  /** amount budgets: billed value of the time at bill rates in `currency` */
  used_cents: number | null;
  /** amount budgets: time with no bill rate in the budget currency (not counted) */
  unrated_seconds: number;
  used_percent: number;
  status: BudgetStatus;
  updated_at: string;
}
export interface ProjectBudgetResponse {
  budget: ProjectBudgetDTO | null;
}

/** Status from usage: reached at 100 %, near from the lowest alert threshold below 100 (default 80). */
export function budgetStatus(usedPercent: number, thresholds: readonly number[]): BudgetStatus {
  if (usedPercent >= 100) return 'reached';
  const below = thresholds.filter((t) => t < 100);
  const near = below.length ? Math.min(...below) : 80;
  return usedPercent >= near ? 'near' : 'ok';
}

// ───────────────────────── invoices ─────────────────────────

export const INVOICE_STATUSES = ['draft', 'issued', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_GROUPINGS = ['project', 'project_person'] as const;
export type InvoiceGrouping = (typeof INVOICE_GROUPINGS)[number];

export const invoiceDraftRequest = z.strictObject({
  client_id: uuid,
  /** inclusive calendar dates, interpreted in `timezone` (default: the admin's timezone) */
  period_from: isoDate,
  period_to: isoDate,
  timezone: z.string().min(1).max(64).optional(),
  group_by: z.enum(INVOICE_GROUPINGS).default('project'),
  tax_rate_bp: z.number().int().min(0).max(10_000).default(0),
  due_date: isoDate.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export const invoiceUpdateRequest = z.strictObject({
  tax_rate_bp: z.number().int().min(0).max(10_000).optional(),
  due_date: isoDate.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export const invoiceLineInput = z.strictObject({
  project_id: uuid.nullable().optional(),
  user_id: uuid.nullable().optional(),
  description: z.string().trim().min(1).max(500),
  hours: z.number().min(0).max(100_000).multipleOf(0.01),
  rate_cents: hourlyCents,
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;
export const invoiceLinesRequest = z.strictObject({ lines: z.array(invoiceLineInput).max(500) });
export const invoiceIssueRequest = z.strictObject({ due_date: isoDate.nullable().optional() });
export const invoiceVoidRequest = z.strictObject({ reason: z.string().max(1000).optional() });

export interface InvoiceLineDTO {
  id: string;
  position: number;
  project_id: string | null;
  project_name: string | null;
  user_id: string | null;
  user_name: string | null;
  description: string;
  hours: number;
  rate_cents: number;
  amount_cents: number;
}
export interface InvoiceSummaryDTO {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  client_id: string;
  client_name: string;
  period_from: string;
  period_to: string;
  currency: string;
  total_cents: number;
  issued_at: string | null;
  due_date: string | null;
  /** Issued invoices: the day payment arrived (slice 4, G23). */
  paid_on: string | null;
  /** When it was last emailed to the client. */
  sent_at: string | null;
  created_at: string;
}
export interface InvoiceDTO extends InvoiceSummaryDTO {
  organization_name: string;
  client: { id: string; name: string; contact_email: string | null; address: string | null };
  timezone: string;
  group_by: InvoiceGrouping;
  subtotal_cents: number;
  tax_rate_bp: number;
  tax_cents: number;
  notes: string | null;
  voided_at: string | null;
  void_reason: string | null;
  payment_note: string | null;
  sent_to: string | null;
  lines: InvoiceLineDTO[];
  /** Draft only: time in the period that had no bill rate in the invoice currency. */
  unrated_seconds: number;
}

/** `POST /v1/admin/invoices/{id}/paid` */
export const invoicePaidRequest = z.strictObject({
  paid_on: isoDate,
  note: z.string().max(500).optional(),
});
/** `POST /v1/admin/invoices/{id}/send`: emails the invoice to the client's contact, or to `to`. */
export const invoiceSendRequest = z.strictObject({
  to: z.email().max(320).optional(),
  message: z.string().max(2000).optional(),
});

// ───────────────────────── payroll ─────────────────────────

export const payrollExportRequest = z.strictObject({
  period_from: isoDate,
  period_to: isoDate,
  timezone: z.string().min(1).max(64).optional(),
  user_ids: z.array(uuid).max(1000).optional(),
});
export interface PayrollExportDTO {
  id: string;
  period_from: string;
  period_to: string;
  timezone: string;
  user_count: number | null;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  row_count: number | null;
  created_at: string;
  expires_at: string | null;
  download_url: string | null;
}
