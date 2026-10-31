import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Stage 4 F7: expenses. */

let env: TestEnv;
let org: Org;
let clientProject: string;

const db = (sql: string, args: unknown[]) => withScope(SYSTEM_SCOPE, () => env.deps.pool.query(sql, args)).then((r) => r.rows);
const claim = (client: Org['admin'], body: Record<string, unknown>) =>
  client.post('/v1/me/expenses', { amount_cents: 4860, currency: 'USD', spent_on: '2026-10-20', category: 'meals', note: 'Lunch with Client A', ...body });

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-10-26T13:00:00Z').getTime();
  org = await makeOrg(env, 'exp');
  const client = await org.admin.post('/v1/admin/clients', { name: 'Client A', currency: 'USD' });
  const project = await org.admin.post('/v1/admin/projects', { name: 'Website rebuild' });
  clientProject = project.body.id;
  await org.admin.put(`/v1/admin/projects/${clientProject}/client`, { client_id: client.body.id });
});

describe('claiming', () => {
  it('attaches a receipt uploaded straight to private storage', async () => {
    const up = await org.users.emp!.client.post('/v1/me/expenses/receipt-uploads', { content_type: 'application/pdf', size_bytes: 20_000 });
    expect(up.status).toBe(201);
    const key = `receipts/${org.id}/${org.users.emp!.id}/${up.body.upload_id}`;
    expect(decodeURIComponent(up.body.url)).toContain(key);
    expect((await claim(org.users.emp!.client, { receipt_upload_id: up.body.upload_id })).body.error.code).toBe('validation_failed');
    await env.store.put(key, Buffer.alloc(20_000), 'application/pdf');
    const r = await claim(org.users.emp!.client, { receipt_upload_id: up.body.upload_id, project_id: clientProject, billable: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', has_receipt: true, billable: true, client_name: 'Client A', amount_cents: 4860 });
    // Someone else's upload id names a key under their own prefix, so it is never found.
    expect((await claim(org.users.emp2!.client, { receipt_upload_id: up.body.upload_id })).body.error.code).toBe('validation_failed');
  });

  it('bills only a client project; refuses future dates', async () => {
    expect((await claim(org.users.emp!.client, { billable: true })).status).toBe(400);
    expect((await claim(org.users.emp!.client, { spent_on: '2027-01-01' })).status).toBe(400);
    const own = await claim(org.users.emp!.client, { note: 'Changed my mind', amount_cents: 999 });
    expect((await org.users.emp!.client.post(`/v1/me/expenses/${own.body.id}/cancel`)).body.status).toBe('cancelled');
  });
});

describe('reviewing', () => {
  it('reaches the team manager in the inbox; nobody reviews their own; sending back needs a reason', async () => {
    expect((await org.users.manager!.client.get('/v1/inbox/counts')).body.expenses).toBe(1);
    const pending = (await org.users.manager!.client.get('/v1/expenses/pending')).body.items;
    expect(pending.map((e: { note: string }) => e.note)).toEqual(['Lunch with Client A']);
    expect((await org.users.emp2!.client.post(`/v1/expenses/${pending[0].id}/approve`)).status).toBe(403);
    const mine = await claim(org.users.manager!.client, { note: 'Team pizza', amount_cents: 6000 });
    expect((await org.users.manager!.client.post(`/v1/expenses/${mine.body.id}/approve`)).status).toBe(403);
    expect((await org.users.manager!.client.post(`/v1/expenses/${pending[0].id}/reject`, {})).status).toBe(400);
    // Batch approve, like any other request in the inbox.
    const batch = await org.users.manager!.client.post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'expense', id: pending[0].id }] });
    expect(batch.body).toMatchObject({ approved: 1, failed: 0 });
    const notes = (await org.users.emp!.client.get('/v1/me/notifications')).body.items;
    expect(notes.find((n: { kind: string }) => n.kind === 'expense_approved').title).toContain('$48.60');
    // The admin reviews the manager's own claim and sends it back with a reason the manager sees.
    await org.admin.post(`/v1/expenses/${mine.body.id}/reject`, { note: 'Please attach the receipt' });
    const back = (await org.users.manager!.client.get('/v1/me/notifications')).body.items.find((n: { kind: string }) => n.kind === 'expense_sent_back');
    expect(back.body).toBe('Please attach the receipt');
  });

  it('receipts open for the claimant, their reviewers and finance only; others are logged', async () => {
    const [e] = (await org.users.emp!.client.get('/v1/me/expenses?from=2026-10-01')).body.items.filter((x: { has_receipt: boolean }) => x.has_receipt);
    expect((await org.users.emp!.client.get(`/v1/expenses/${e.id}/receipt-url`)).status).toBe(200);
    expect((await org.users.emp2!.client.get(`/v1/expenses/${e.id}/receipt-url`)).status).toBe(403);
    expect((await org.users.manager!.client.get(`/v1/expenses/${e.id}/receipt-url`)).body.url).toMatch(/^memory:\/\/get\//);
    const log = (await org.users.emp!.client.get('/v1/me/access-log')).body.items.map((x: { action: string }) => x.action);
    expect(log).toContain('expense.receipt_view');
  });
});

describe('billing and paying', () => {
  it('approved billable expenses go on the client draft invoice once', async () => {
    const draft = await org.admin.post('/v1/admin/invoices', { client_id: (await org.admin.get('/v1/admin/clients')).body.items[0].id, period_from: '2026-10-01', period_to: '2026-10-31' });
    expect(draft.status).toBe(201);
    const line = draft.body.lines.find((l: { expense_id: string | null }) => l.expense_id);
    expect(line).toMatchObject({ hours: 1, rate_cents: 4860, amount_cents: 4860 });
    expect(line.description).toContain('Lunch with Client A');
    const again = await org.admin.post('/v1/admin/invoices', { client_id: draft.body.client_id, period_from: '2026-10-01', period_to: '2026-10-31' });
    expect(again.body.lines.filter((l: { expense_id: string | null }) => l.expense_id)).toEqual([]);
    const [mine] = (await org.users.emp!.client.get('/v1/me/expenses?from=2026-10-01')).body.items.filter((x: { billable: boolean }) => x.billable);
    expect(mine.invoice).toMatchObject({ id: draft.body.id, status: 'draft' });
  });

  it('the payroll file reimburses approved expenses once, and the claimant sees them paid', async () => {
    let me = (await org.users.emp!.client.get('/v1/me/expenses?from=2026-10-01')).body;
    expect(me.totals.to_be_paid).toEqual([{ currency: 'USD', cents: 4860, count: 1 }]);
    const ex = await org.admin.post('/v1/admin/payroll-exports', { period_from: '2026-10-01', period_to: '2026-10-31', timezone: 'UTC' });
    await env.drain();
    const csv = env.store.objects.get(`payroll/${org.id}/${ex.body.id}.csv`)!.body.toString();
    const [header, ...rows] = csv.trim().split(/\r?\n/);
    expect(header).toContain('reimbursements');
    expect(rows.find((r) => r.startsWith('exp emp'))).toMatch(/,USD,.*,48\.60,0\.00,0\.00$/);
    me = (await org.users.emp!.client.get('/v1/me/expenses?from=2026-10-01')).body;
    expect(me.totals).toMatchObject({ to_be_paid: [], paid_this_year: [{ currency: 'USD', cents: 4860, count: 1 }] });
    // The same period again includes it again; another period's file doesn't.
    const same = await org.admin.post('/v1/admin/payroll-exports', { period_from: '2026-10-01', period_to: '2026-10-31', timezone: 'UTC' });
    const next = await org.admin.post('/v1/admin/payroll-exports', { period_from: '2026-11-01', period_to: '2026-11-30', timezone: 'UTC' });
    await env.drain();
    expect(env.store.objects.get(`payroll/${org.id}/${same.body.id}.csv`)!.body.toString()).toContain('48.60');
    expect(env.store.objects.get(`payroll/${org.id}/${next.body.id}.csv`)!.body.toString()).not.toContain('48.60');
  });

  it('is part of Pro', async () => {
    const std = await makeOrg(env, 'expstd', 'standard');
    expect((await claim(std.users.emp!.client, {})).status).toBe(402);
    const rows = await db(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action LIKE 'expense.%' AND metadata::text LIKE '%4860%'`, [org.id]);
    expect(rows[0].n).toBe(0);
  });
});
