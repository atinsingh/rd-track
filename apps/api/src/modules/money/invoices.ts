import {
  billableHours,
  invoiceTotals,
  lineAmountCents,
  type InvoiceDTO,
  type InvoiceGrouping,
  type InvoiceLineInput,
  type InvoiceSummaryDTO,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { toCsv } from '../../lib/csv';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { dateRange, groupSeconds, timeWithBillRates, userTimezone } from './time';

/**
 * Invoices from tracked time (Stage 3). A draft is built from a client and a period: one
 * line per project and bill rate (or per project, person and rate), using the bill rate in
 * effect on each session's start date. Drafts can be edited; issuing assigns the next
 * number (INV-YYYY-NNNN, gap-free per organization and year) and locks the invoice — the
 * database refuses later changes (migration 005 triggers). An issued invoice can only be
 * voided; its number is never reused.
 */

const SUMMARY_SELECT = `
  SELECT i.id, i.number, i.status, i.client_id, c.name AS client_name, i.period_from::text AS period_from,
         i.period_to::text AS period_to, i.currency, i.total_cents, i.issued_at, i.due_date::text AS due_date, i.created_at
  FROM invoices i JOIN clients c ON c.id = i.client_id`;

const locked = () => errors.conflict('invoice_locked', 'This invoice has been issued and can no longer be changed. Void it and create a new one.');

export async function listInvoices(q: Queryable, orgId: string): Promise<InvoiceSummaryDTO[]> {
  return many<InvoiceSummaryDTO>(q, `${SUMMARY_SELECT} WHERE i.organization_id = $1 ORDER BY i.created_at DESC LIMIT 500`, [orgId]);
}

export async function getInvoice(q: Queryable, orgId: string, id: string): Promise<InvoiceDTO> {
  const inv = await one<Omit<InvoiceDTO, 'lines' | 'client'> & { client_email: string | null; client_address: string | null }>(
    q,
    `SELECT i.id, i.number, i.status, i.client_id, c.name AS client_name, c.contact_email AS client_email, c.address AS client_address,
            o.name AS organization_name, i.period_from::text AS period_from, i.period_to::text AS period_to, i.timezone, i.group_by,
            i.currency, i.subtotal_cents, i.tax_rate_bp, i.tax_cents, i.total_cents, i.unrated_seconds, i.issued_at,
            i.due_date::text AS due_date, i.notes, i.voided_at, i.void_reason, i.created_at
     FROM invoices i JOIN clients c ON c.id = i.client_id JOIN organizations o ON o.id = i.organization_id
     WHERE i.organization_id = $1 AND i.id = $2`,
    [orgId, id],
  );
  if (!inv) throw errors.notFound('Invoice');
  const lines = await many<InvoiceDTO['lines'][number]>(
    q,
    `SELECT l.id, l.position, l.project_id, p.name AS project_name, l.user_id, u.display_name AS user_name,
            l.description, l.hours, l.rate_cents, l.amount_cents
     FROM invoice_lines l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = l.user_id
     WHERE l.invoice_id = $1 ORDER BY l.position`,
    [id],
  );
  const { client_email, client_address, ...rest } = inv;
  return { ...rest, client: { id: inv.client_id, name: inv.client_name, contact_email: client_email, address: client_address }, lines };
}

async function lockInvoice(q: Queryable, orgId: string, id: string) {
  const r = await one<{ status: string; tax_rate_bp: number }>(
    q,
    'SELECT status, tax_rate_bp FROM invoices WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, id],
  );
  if (!r) throw errors.notFound('Invoice');
  return r;
}

async function writeLines(q: Queryable, orgId: string, invoiceId: string, lines: { project_id: string | null; user_id: string | null; description: string; hours: number; rate_cents: number }[]) {
  await q.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [invoiceId]);
  let pos = 0;
  const amounts: number[] = [];
  for (const l of lines) {
    const amount = lineAmountCents(l.hours, l.rate_cents);
    amounts.push(amount);
    await q.query(
      `INSERT INTO invoice_lines (organization_id, invoice_id, position, project_id, user_id, description, hours, rate_cents, amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, invoiceId, ++pos, l.project_id, l.user_id, l.description, l.hours.toFixed(2), l.rate_cents, amount],
    );
  }
  return amounts;
}

async function writeTotals(q: Queryable, invoiceId: string, taxRateBp: number) {
  const amounts = (await many<{ amount_cents: number }>(q, 'SELECT amount_cents FROM invoice_lines WHERE invoice_id = $1', [invoiceId])).map((r) =>
    Number(r.amount_cents),
  );
  const t = invoiceTotals(amounts, taxRateBp);
  await q.query(
    `UPDATE invoices SET subtotal_cents = $2, tax_rate_bp = $3, tax_cents = $4, total_cents = $5, updated_at = now() WHERE id = $1`,
    [invoiceId, t.subtotal_cents, taxRateBp, t.tax_cents, t.total_cents],
  );
}

export async function createDraftInvoice(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: {
    client_id: string;
    period_from: string;
    period_to: string;
    timezone?: string;
    group_by: InvoiceGrouping;
    tax_rate_bp: number;
    due_date?: string | null;
    notes?: string | null;
  },
  requestId?: string,
): Promise<InvoiceDTO> {
  const orgId = actor.organizationId;
  const client = await one<{ id: string; currency: string; archived: boolean }>(
    q,
    'SELECT id, currency, archived FROM clients WHERE organization_id = $1 AND id = $2',
    [orgId, input.client_id],
  );
  if (!client) throw errors.notFound('Client');
  if (client.archived) throw errors.validation('This client is archived. Restore it before invoicing.');
  const tz = input.timezone ?? (await userTimezone(q, actor.userId));
  const range = await dateRange(q, input.period_from, input.period_to, tz);
  const projectIds = (await many<{ id: string }>(q, 'SELECT id FROM projects WHERE organization_id = $1 AND client_id = $2', [orgId, client.id])).map(
    (r) => r.id,
  );

  // TODO(timesheets): count approved time only once timesheets land; this uses all recorded time.
  const rows = projectIds.length ? await timeWithBillRates(q, orgId, range, { projectIds }) : [];
  const billable = (r: (typeof rows)[number]) => r.rate_cents !== null && r.rate_currency === client.currency;
  const byPerson = input.group_by === 'project_person';
  const groups = groupSeconds(rows, (r) => (billable(r) ? `${r.project_id}|${byPerson ? r.user_id : ''}|${r.rate_cents}` : null));
  const lines = [...groups.values()]
    .map((g) => ({
      project_id: g.first.project_id,
      user_id: byPerson ? g.first.user_id : null,
      description: byPerson ? `${g.first.project_name} — ${g.first.user_name}` : g.first.project_name!,
      hours: billableHours(g.seconds),
      rate_cents: g.first.rate_cents!,
      sort: [g.first.project_name ?? '', byPerson ? g.first.user_name : ''] as const,
    }))
    .filter((l) => l.hours > 0)
    .sort((a, b) => a.sort[0].localeCompare(b.sort[0]) || a.sort[1].localeCompare(b.sort[1]) || b.rate_cents - a.rate_cents);
  const unrated = rows.filter((r) => !billable(r)).reduce((n, r) => n + Number(r.seconds), 0);

  const inv = await one<{ id: string }>(
    q,
    `INSERT INTO invoices (organization_id, client_id, period_from, period_to, timezone, group_by, currency, tax_rate_bp,
                           unrated_seconds, due_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [orgId, client.id, input.period_from, input.period_to, tz, input.group_by, client.currency, input.tax_rate_bp, unrated,
      input.due_date ?? null, input.notes ?? null, actor.userId],
  );
  await writeLines(q, orgId, inv!.id, lines);
  await writeTotals(q, inv!.id, input.tax_rate_bp);
  await audit(q, {
    organizationId: orgId,
    actor,
    action: 'invoice.create',
    targetType: 'invoice',
    targetId: inv!.id,
    requestId,
    metadata: { client_id: client.id, period_from: input.period_from, period_to: input.period_to, lines: lines.length },
  });
  return getInvoice(q, orgId, inv!.id);
}

export async function updateDraftInvoice(
  q: Queryable,
  actor: UserActor,
  id: string,
  input: { tax_rate_bp?: number; due_date?: string | null; notes?: string | null },
  requestId?: string,
): Promise<InvoiceDTO> {
  const cur = await lockInvoice(q, actor.organizationId, id);
  if (cur.status !== 'draft') throw locked();
  await q.query(
    `UPDATE invoices SET
       due_date = CASE WHEN $2::boolean THEN $3::date ELSE due_date END,
       notes = CASE WHEN $4::boolean THEN $5 ELSE notes END, updated_at = now()
     WHERE id = $1`,
    [id, input.due_date !== undefined, input.due_date ?? null, input.notes !== undefined, input.notes ?? null],
  );
  await writeTotals(q, id, input.tax_rate_bp ?? cur.tax_rate_bp);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'invoice.update', targetType: 'invoice', targetId: id, requestId, metadata: { fields: Object.keys(input) } });
  return getInvoice(q, actor.organizationId, id);
}

export async function replaceDraftLines(q: Queryable, actor: UserActor, id: string, lines: InvoiceLineInput[], requestId?: string): Promise<InvoiceDTO> {
  const orgId = actor.organizationId;
  const cur = await lockInvoice(q, orgId, id);
  if (cur.status !== 'draft') throw locked();
  const projectIds = [...new Set(lines.map((l) => l.project_id).filter((x): x is string => !!x))];
  const userIds = [...new Set(lines.map((l) => l.user_id).filter((x): x is string => !!x))];
  const okProjects = await many(q, 'SELECT id FROM projects WHERE organization_id = $1 AND id = ANY($2::uuid[])', [orgId, projectIds]);
  const okUsers = await many(q, 'SELECT id FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[])', [orgId, userIds]);
  if (okProjects.length !== projectIds.length || okUsers.length !== userIds.length) throw errors.validation('A line refers to an unknown project or person');
  await writeLines(
    q,
    orgId,
    id,
    lines.map((l) => ({ project_id: l.project_id ?? null, user_id: l.user_id ?? null, description: l.description, hours: l.hours, rate_cents: l.rate_cents })),
  );
  await writeTotals(q, id, cur.tax_rate_bp);
  await audit(q, { organizationId: orgId, actor, action: 'invoice.update_lines', targetType: 'invoice', targetId: id, requestId, metadata: { lines: lines.length } });
  return getInvoice(q, orgId, id);
}

export async function issueInvoice(deps: Deps, q: Queryable, actor: UserActor, id: string, dueDate: string | null | undefined, requestId?: string): Promise<InvoiceDTO> {
  const orgId = actor.organizationId;
  const cur = await lockInvoice(q, orgId, id);
  if (cur.status !== 'draft') throw locked();
  const lines = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = $1', [id]);
  if (!lines?.n) throw errors.validation('Add at least one line before issuing this invoice');
  // Serialize numbering per organization so numbers are unique and gap-free.
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice-number:${orgId}`]);
  const now = deps.now();
  const year = now.getUTCFullYear();
  const last = await one<{ n: number | null }>(
    q,
    `SELECT max(split_part(number, '-', 3)::int) AS n FROM invoices WHERE organization_id = $1 AND number LIKE $2`,
    [orgId, `INV-${year}-%`],
  );
  const number = `INV-${year}-${String((last?.n ?? 0) + 1).padStart(4, '0')}`;
  await q.query(
    `UPDATE invoices SET status = 'issued', number = $2, issued_at = $3,
       due_date = CASE WHEN $4::boolean THEN $5::date ELSE due_date END, updated_at = now()
     WHERE id = $1`,
    [id, number, now.toISOString(), dueDate !== undefined, dueDate ?? null],
  );
  await audit(q, { organizationId: orgId, actor, action: 'invoice.issue', targetType: 'invoice', targetId: id, requestId, metadata: { number } });
  return getInvoice(q, orgId, id);
}

export async function voidInvoice(deps: Deps, q: Queryable, actor: UserActor, id: string, reason: string | undefined, requestId?: string): Promise<InvoiceDTO> {
  const orgId = actor.organizationId;
  const cur = await lockInvoice(q, orgId, id);
  if (cur.status === 'draft') throw errors.conflict('invoice_not_issued', 'Drafts are deleted, not voided.');
  if (cur.status === 'void') throw errors.conflict('invoice_void', 'This invoice is already void.');
  await q.query(`UPDATE invoices SET status = 'void', voided_at = $2, void_reason = $3, updated_at = now() WHERE id = $1`, [
    id,
    deps.now().toISOString(),
    reason ?? null,
  ]);
  await audit(q, { organizationId: orgId, actor, action: 'invoice.void', targetType: 'invoice', targetId: id, requestId });
  return getInvoice(q, orgId, id);
}

export async function deleteDraftInvoice(q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const cur = await lockInvoice(q, actor.organizationId, id);
  if (cur.status !== 'draft') throw locked();
  await q.query('DELETE FROM invoices WHERE id = $1', [id]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'invoice.delete', targetType: 'invoice', targetId: id, requestId });
  return { ok: true };
}

const money = (cents: number) => (cents / 100).toFixed(2);

/** CSV of one invoice: its lines, then subtotal, tax and total rows. Formula-injection safe (lib/csv). */
export async function invoiceCsv(q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<{ filename: string; csv: string }> {
  const inv = await getInvoice(q, actor.organizationId, id);
  const ref = inv.number ?? `DRAFT-${inv.id.slice(0, 8)}`;
  const head = [ref, inv.status, inv.client_name, inv.period_from, inv.period_to];
  const rows: unknown[][] = inv.lines.map((l) => [...head, l.project_name, l.user_name, l.description, l.hours.toFixed(2), money(l.rate_cents), money(l.amount_cents), inv.currency]);
  rows.push([...head, null, null, 'Subtotal', null, null, money(inv.subtotal_cents), inv.currency]);
  rows.push([...head, null, null, `Tax (${(inv.tax_rate_bp / 100).toFixed(2)}%)`, null, null, money(inv.tax_cents), inv.currency]);
  rows.push([...head, null, null, 'Total', null, null, money(inv.total_cents), inv.currency]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'invoice.export', targetType: 'invoice', targetId: id, requestId });
  return {
    filename: `${ref}.csv`,
    csv: toCsv(['invoice', 'status', 'client', 'period_from', 'period_to', 'project', 'person', 'description', 'hours', 'rate', 'amount', 'currency'], rows),
  };
}
