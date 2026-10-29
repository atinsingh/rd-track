import { randomUUID } from 'node:crypto';
import {
  RECEIPT_MAX_BYTES,
  type ExpenseCreate,
  type ExpenseDTO,
  type MoneyTotal,
  type MyExpensesResponse,
  type ReceiptUploadResponse,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { isTeamManagerOf } from '../authz';
import { assertEntitlement } from '../billing/service';
import { publish } from '../engine/events';

/**
 * Expenses (Stage 4 F7). A person claims what they spent for work; their team manager, or
 * an org admin when they have none, approves it in the approvals inbox. Receipts sit in
 * private object storage under the claimant's own prefix and are only ever handed out as a
 * five-minute link, audited. Amounts never go into audit metadata.
 */

const RECEIPT_UPLOAD_SECONDS = 600;
const receiptKey = (orgId: string, userId: string, uploadId: string) => `receipts/${orgId}/${userId}/${uploadId}`;

const gate = (deps: Deps, q: Queryable, orgId: string) => assertEntitlement(q, orgId, 'expenses', deps.now(), 'Expenses');

export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

const SELECT = `
  SELECT e.id, e.user_id, u.display_name AS user_name, e.amount_cents::int AS amount_cents, e.currency, e.spent_on::text AS spent_on,
    e.category, e.project_id, p.name AS project_name, c.name AS client_name, e.billable, e.note, e.receipt_key IS NOT NULL AS has_receipt,
    e.status, e.review_note, r.display_name AS reviewed_by_name, e.reviewed_at, e.created_at,
    CASE WHEN e.reimbursed_period_from IS NULL THEN NULL
      ELSE json_build_object('from', e.reimbursed_period_from::text, 'to', e.reimbursed_period_to::text) END AS reimbursed_period,
    (SELECT json_build_object('id', i.id, 'number', i.number, 'status', i.status) FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
     WHERE l.expense_id = e.id AND i.status <> 'void' LIMIT 1) AS invoice
  FROM expenses e JOIN users u ON u.id = e.user_id
  LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN users r ON r.id = e.reviewed_by`;

async function getExpense(q: Queryable, orgId: string, id: string): Promise<ExpenseDTO> {
  const e = await one<ExpenseDTO>(q, `${SELECT} WHERE e.organization_id = $1 AND e.id = $2`, [orgId, id]);
  if (!e) throw errors.notFound('Expense');
  return e;
}

// ───────────── claiming ─────────────

/** Where to upload a receipt; the upload id names it when the claim is created. */
export async function receiptUpload(deps: Deps, q: Queryable, actor: UserActor, contentType: string): Promise<ReceiptUploadResponse> {
  await gate(deps, q, actor.organizationId);
  const id = randomUUID();
  const put = await deps.store.presignPut(receiptKey(actor.organizationId, actor.userId, id), contentType, RECEIPT_UPLOAD_SECONDS);
  return { upload_id: id, url: put.url, headers: put.headers, expires_at: new Date(deps.now().getTime() + RECEIPT_UPLOAD_SECONDS * 1000).toISOString() };
}

export async function createExpense(deps: Deps, q: Queryable, actor: UserActor, input: ExpenseCreate, requestId?: string): Promise<ExpenseDTO> {
  await gate(deps, q, actor.organizationId);
  if (input.spent_on > new Date(deps.now().getTime() + 86_400_000).toISOString().slice(0, 10)) throw errors.validation('The date is in the future');
  if (input.project_id) {
    const p = await one<{ client_id: string | null }>(q, 'SELECT client_id FROM projects WHERE organization_id = $1 AND id = $2', [actor.organizationId, input.project_id]);
    if (!p) throw errors.notFound('Project');
    if (input.billable && !p.client_id) throw errors.validation('This project has no client to bill');
  } else if (input.billable) {
    throw errors.validation('Choose the client project to bill this to');
  }
  let receipt: { key: string; size: number } | null = null;
  if (input.receipt_upload_id) {
    const key = receiptKey(actor.organizationId, actor.userId, input.receipt_upload_id);
    const head = await deps.store.head(key);
    if (!head) throw errors.validation('The receipt has not finished uploading');
    if (head.size > RECEIPT_MAX_BYTES) {
      await deps.store.delete(key);
      throw errors.validation('Receipts can be up to 10 MB');
    }
    receipt = { key, size: head.size };
  }
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO expenses (organization_id, user_id, project_id, category, amount_cents, currency, spent_on, note, billable, receipt_key, receipt_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [actor.organizationId, actor.userId, input.project_id ?? null, input.category, input.amount_cents, input.currency, input.spent_on, input.note, input.billable,
      receipt?.key ?? null, receipt?.size ?? null],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'expense.submitted', targetType: 'expense', targetId: r!.id, targetUserId: actor.userId, requestId });
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'expense.submitted',
    subjectUserId: actor.userId,
    actorUserId: actor.userId,
    data: { expense_id: r!.id, user_name: actor.displayName, amount: money(input.amount_cents, input.currency), note: input.note },
  });
  return getExpense(q, actor.organizationId, r!.id);
}

export async function cancelExpense(q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<ExpenseDTO> {
  const r = await q.query(`UPDATE expenses SET status = 'cancelled', updated_at = now() WHERE organization_id = $1 AND id = $2 AND user_id = $3 AND status = 'pending'`, [
    actor.organizationId,
    id,
    actor.userId,
  ]);
  if (!r.rowCount) throw errors.conflict('not_pending', 'Only a claim that is still waiting can be withdrawn');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'expense.cancelled', targetType: 'expense', targetId: id, targetUserId: actor.userId, requestId });
  return getExpense(q, actor.organizationId, id);
}

function totals(rows: { currency: string; cents: number; count: number; bucket: string }[], bucket: string): MoneyTotal[] {
  return rows.filter((r) => r.bucket === bucket).map(({ currency, cents, count }) => ({ currency, cents: Number(cents), count }));
}

export async function myExpenses(deps: Deps, q: Queryable, actor: UserActor, from: string): Promise<MyExpensesResponse> {
  const items = await many<ExpenseDTO>(q, `${SELECT} WHERE e.organization_id = $1 AND e.user_id = $2 AND e.spent_on >= $3 ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 500`, [
    actor.organizationId,
    actor.userId,
    from,
  ]);
  const year = `${deps.now().getUTCFullYear()}-01-01`;
  const sums = await many<{ bucket: string; currency: string; cents: number; count: number }>(
    q,
    `SELECT CASE WHEN status = 'pending' THEN 'waiting'
                 WHEN status = 'approved' AND reimbursed_period_from IS NULL THEN 'to_be_paid'
                 ELSE 'paid' END AS bucket,
            currency, sum(amount_cents)::bigint AS cents, count(*)::int AS count
     FROM expenses WHERE organization_id = $1 AND user_id = $2
       AND (status = 'pending' OR (status = 'approved' AND (reimbursed_period_from IS NULL OR reimbursed_period_to >= $3)))
     GROUP BY 1, 2 ORDER BY 2`,
    [actor.organizationId, actor.userId, year],
  );
  return { items, totals: { waiting: totals(sums, 'waiting'), to_be_paid: totals(sums, 'to_be_paid'), paid_this_year: totals(sums, 'paid') } };
}

// ───────────── reviewing ─────────────

/** Claims waiting for this reviewer: their teams' people, or everyone's for org admins. Never their own. */
export async function pendingExpenses(deps: Deps, q: Queryable, actor: UserActor): Promise<ExpenseDTO[]> {
  await gate(deps, q, actor.organizationId);
  return many<ExpenseDTO>(
    q,
    `${SELECT} WHERE e.organization_id = $1 AND e.status = 'pending' AND e.user_id <> $2
       AND ($3::boolean OR EXISTS (SELECT 1 FROM team_memberships m JOIN team_memberships t ON t.team_id = m.team_id
         WHERE m.user_id = $2 AND m.role = 'manager' AND m.valid_to IS NULL AND t.user_id = e.user_id AND t.valid_to IS NULL))
     ORDER BY e.created_at`,
    [actor.organizationId, actor.userId, isAdmin(actor)],
  );
}

async function assertReviewer(q: Queryable, actor: UserActor, claimant: string) {
  if (claimant === actor.userId) throw errors.forbidden('You cannot review your own expense');
  if (!isAdmin(actor) && !(await isTeamManagerOf(q, actor.userId, claimant))) throw errors.forbidden();
}

export async function reviewExpense(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  approve: boolean,
  note: string | undefined,
  requestId?: string,
): Promise<ExpenseDTO> {
  await gate(deps, q, actor.organizationId);
  const e = await one<{ user_id: string; status: string; amount_cents: number; currency: string }>(
    q,
    'SELECT user_id, status, amount_cents, currency FROM expenses WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [actor.organizationId, id],
  );
  if (!e) throw errors.notFound('Expense');
  await assertReviewer(q, actor, e.user_id);
  if (e.status !== 'pending') throw errors.conflict('already_reviewed', 'This expense has already been reviewed');
  if (!approve && (note ?? '').trim().length < 3) throw errors.validation('Say why you are sending it back');
  await q.query(`UPDATE expenses SET status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5, updated_at = now() WHERE id = $1`, [
    id,
    approve ? 'approved' : 'rejected',
    actor.userId,
    deps.now().toISOString(),
    note?.trim() || null,
  ]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: approve ? 'expense.approved' : 'expense.sent_back',
    targetType: 'expense',
    targetId: id,
    targetUserId: e.user_id,
    requestId,
  });
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'expense.decided',
    subjectUserId: e.user_id,
    actorUserId: actor.userId,
    data: { expense_id: id, approved: approve, reviewer_name: actor.displayName, review_note: note?.trim() || null, amount: money(Number(e.amount_cents), e.currency) },
  });
  return getExpense(q, actor.organizationId, id);
}

/**
 * A five-minute link to a receipt, for the claimant, their reviewers and the people who run
 * money (admins, finance). Anyone else's view is written to the claimant's access log.
 */
export async function receiptUrl(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<{ url: string }> {
  const e = await one<{ user_id: string; receipt_key: string | null }>(q, 'SELECT user_id, receipt_key FROM expenses WHERE organization_id = $1 AND id = $2', [
    actor.organizationId,
    id,
  ]);
  if (!e) throw errors.notFound('Expense');
  const allowed =
    e.user_id === actor.userId || isAdmin(actor) || actor.orgRole === 'finance' || (await isTeamManagerOf(q, actor.userId, e.user_id));
  if (!allowed) throw errors.forbidden();
  if (!e.receipt_key) throw errors.notFound('Receipt');
  if (e.user_id !== actor.userId) {
    await audit(q, { organizationId: actor.organizationId, actor, action: 'expense.receipt_view', targetType: 'expense', targetId: id, targetUserId: e.user_id, requestId });
  }
  return { url: await deps.store.presignGet(e.receipt_key, 300) };
}

/** Finance and admins: approved expenses, newest first, for invoicing and payroll checks. */
export async function approvedExpenses(deps: Deps, q: Queryable, actor: UserActor, from: string): Promise<ExpenseDTO[]> {
  await gate(deps, q, actor.organizationId);
  return many<ExpenseDTO>(q, `${SELECT} WHERE e.organization_id = $1 AND e.status = 'approved' AND e.spent_on >= $2 ORDER BY e.spent_on DESC LIMIT 1000`, [
    actor.organizationId,
    from,
  ]);
}

// ───────────── payroll ─────────────

/**
 * Approved expenses a payroll file for `period` reimburses: approved before the period
 * ended and not already reimbursed by another period's file. Marks them as reimbursed by
 * this period, so making the same period's file again includes them again, and no other
 * period's file does.
 */
export async function reimbursementsFor(
  q: Queryable,
  orgId: string,
  period: { from: string; to: string; endsAt: string },
  userIds: string[] | null,
): Promise<{ user_id: string; currency: string; cents: number }[]> {
  const rows = await many<{ id: string; user_id: string; currency: string; amount_cents: number }>(
    q,
    `UPDATE expenses SET reimbursed_period_from = $2, reimbursed_period_to = $3, updated_at = now()
     WHERE organization_id = $1 AND status = 'approved' AND reviewed_at < $4
       AND ($5::uuid[] IS NULL OR user_id = ANY($5))
       AND (reimbursed_period_from IS NULL OR (reimbursed_period_from = $2 AND reimbursed_period_to = $3))
     RETURNING id, user_id, currency, amount_cents`,
    [orgId, period.from, period.to, period.endsAt, userIds],
  );
  const sums = new Map<string, { user_id: string; currency: string; cents: number }>();
  for (const r of rows) {
    const k = `${r.user_id}|${r.currency}`;
    const s = sums.get(k) ?? { user_id: r.user_id, currency: r.currency, cents: 0 };
    s.cents += Number(r.amount_cents);
    sums.set(k, s);
  }
  return [...sums.values()];
}
