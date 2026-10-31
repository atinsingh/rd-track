import { z } from 'zod';
import { uuid } from './events';
import { currencyCode } from './money';

// Expenses (Stage 4 F7, Pro): claims for what people spent for work.

export const EXPENSE_CATEGORIES = ['travel', 'meals', 'equipment', 'software', 'training', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  travel: 'Travel',
  meals: 'Meals',
  equipment: 'Equipment',
  software: 'Software',
  training: 'Training',
  other: 'Other',
};

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const RECEIPT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const;

/** Step 1 of attaching a receipt: where to upload it. */
export const receiptUploadRequest = z.strictObject({
  content_type: z.enum(RECEIPT_CONTENT_TYPES),
  size_bytes: z.number().int().min(1).max(RECEIPT_MAX_BYTES),
});
export interface ReceiptUploadResponse {
  /** Pass this as `receipt_upload_id` when creating the claim. */
  upload_id: string;
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const expenseCreateRequest = z.strictObject({
  amount_cents: z.number().int().min(1).max(10_000_000),
  currency: currencyCode,
  spent_on: calendarDate,
  category: z.enum(EXPENSE_CATEGORIES),
  project_id: uuid.nullable().optional(),
  /** Bill it to the project's client. Needs a project with a client. */
  billable: z.boolean().default(false),
  note: z.string().trim().min(1).max(500),
  receipt_upload_id: uuid.optional(),
});
export type ExpenseCreate = z.infer<typeof expenseCreateRequest>;

export const EXPENSE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export interface ExpenseDTO {
  id: string;
  user_id: string;
  user_name: string;
  amount_cents: number;
  currency: string;
  spent_on: string;
  category: ExpenseCategory;
  project_id: string | null;
  project_name: string | null;
  client_name: string | null;
  billable: boolean;
  note: string;
  has_receipt: boolean;
  status: ExpenseStatus;
  review_note: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  created_at: string;
  /** Set once a payroll file for that period has reimbursed it. */
  reimbursed_period: { from: string; to: string } | null;
  /** The invoice it was billed on (not counting void ones). */
  invoice: { id: string; number: string | null; status: 'draft' | 'issued' } | null;
}

/** Sums by currency: claims can be in more than one. */
export interface MoneyTotal {
  currency: string;
  cents: number;
  count: number;
}

export interface MyExpensesResponse {
  items: ExpenseDTO[];
  totals: {
    waiting: MoneyTotal[];
    /** Approved, not yet in a payroll file. */
    to_be_paid: MoneyTotal[];
    /** Reimbursed this calendar year. */
    paid_this_year: MoneyTotal[];
  };
}
