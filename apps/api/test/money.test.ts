import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
import { checkAllBudgets } from '../src/modules/money/budgets';
import {
  bucket,
  enrollDevice,
  event,
  makeOrg,
  minutes,
  sendBatch,
  testEnv,
  type Device,
  type Org,
  type TestEnv,
} from './helpers';

/**
 * Stage 3 money: rates, budgets, invoices, payroll. The clock stands at
 * 2026-10-26T13:00Z; sessions are replayed from earlier that day or the day before.
 */
let env: TestEnv;
let org: Org;
let other: Org;
let dev: Device; // emp
let dev2: Device; // emp2
let clientId: string;
let budgetProjectId: string;

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'money');
  other = await makeOrg(env, 'money2');
  dev = await enrollDevice(env, org, 'emp');
  dev2 = await enrollDevice(env, org, 'emp2');
});

/** A stopped agent session of `n` measured minutes (60 s each) on `projectId`. */
async function session(d: Device, projectId: string, startIso: string, n: number) {
  const sid = randomUUID();
  const end = new Date(Date.parse(startIso) + n * 60_000).toISOString();
  const res = await sendBatch(env, d, [
    event(d, sid, 'session.started.v1', { project_id: projectId }, startIso),
    ...minutes(startIso, n).map((m) => bucket(d, sid, m, 50, 10)),
    event(d, sid, 'session.stopped.v1', { reason: 'user' }, end),
  ]);
  expect(res.status).toBe(200);
  await env.drain();
  return { sid, results: res.body.results as { status: string; reason?: string }[] };
}

const count = async (sql: string, params: unknown[]) => Number((await env.deps.pool.query(sql, params)).rows[0].n);

describe('plan gate and roles', () => {
  it('needs the Pro plan (402) and an org admin (403)', async () => {
    const std = await makeOrg(env, 'money-std', 'standard');
    for (const url of ['/v1/admin/clients', '/v1/admin/rates/pay', '/v1/admin/invoices', '/v1/admin/budgets', '/v1/admin/payroll-exports']) {
      const r = await std.admin.get(url);
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe('plan_upgrade_required');
    }
    expect((await std.users.emp!.client.get('/v1/me/pay-rate')).status).toBe(402);
    expect((await std.admin.put(`/v1/projects/${std.projectId}/budget`, { kind: 'hours', limit_hours: 10 })).status).toBe(402);

    expect((await org.users.emp!.client.get('/v1/admin/rates/pay')).status).toBe(403);
    expect((await org.users.manager!.client.get('/v1/admin/invoices')).status).toBe(403);
    expect((await org.users.manager!.client.post('/v1/admin/clients', { name: 'Nope' })).status).toBe(403);
  });
});

describe('rates', () => {
  it('resolves pay and bill rates by the date each session started', async () => {
    const pid = org.projectId;
    const adm = org.admin;
    expect((await adm.post('/v1/admin/rates/pay', { user_id: org.users.emp!.id, amount_cents: 4000, effective_from: '2026-01-01' })).status).toBe(201);
    expect((await adm.post('/v1/admin/rates/pay', { user_id: org.users.emp!.id, amount_cents: 5000, effective_from: '2026-10-26' })).status).toBe(201);
    const dup = await adm.post('/v1/admin/rates/pay', { user_id: org.users.emp!.id, amount_cents: 1, effective_from: '2026-10-26' });
    expect(dup.status).toBe(409);
    expect((await adm.post('/v1/admin/rates/pay', { user_id: org.users.emp2!.id, amount_cents: 3000, effective_from: '2026-01-01' })).status).toBe(201);
    expect((await adm.post('/v1/admin/rates/bill', { project_id: pid, amount_cents: 10_000, effective_from: '2026-01-01' })).status).toBe(201);
    expect(
      (await adm.post('/v1/admin/rates/bill', { project_id: pid, user_id: org.users.emp!.id, amount_cents: 15_000, effective_from: '2026-10-26' })).status,
    ).toBe(201);

    // emp: 60 min yesterday (old rates), 20 min today (new rates); emp2: 30 min of approved manual time.
    await session(dev, pid, '2026-10-25T10:00:00.000Z', 60);
    await session(dev, pid, '2026-10-26T09:00:00.000Z', 20);
    const manual = await org.users.emp2!.client.post('/v1/me/time-corrections', {
      requested: { started_at: '2026-10-24T14:00:00.000Z', ended_at: '2026-10-24T14:30:00.000Z', project_id: pid },
      reason: 'Workshop without the laptop',
    });
    expect(manual.status).toBe(201);
    expect((await org.users.manager!.client.post(`/v1/corrections/${manual.body.id}/approve`)).status).toBe(200);

    const exp = await adm.post('/v1/admin/payroll-exports', { period_from: '2026-10-24', period_to: '2026-10-26', timezone: 'UTC' });
    expect(exp.status).toBe(201);
    await env.drain();
    const ready = await adm.get(`/v1/admin/payroll-exports/${exp.body.id}`);
    expect(ready.body).toMatchObject({ status: 'ready', row_count: 3, user_count: 2 });
    expect(ready.body.download_url).toBeTruthy();
    const csv = (await env.store.get(`payroll/${org.id}/${exp.body.id}.csv`))!.toString();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('employee,email,period_from,period_to,hours,hourly_rate,currency,gross_pay,rate_effective_from');
    expect(lines).toContain('money emp,emp@money.test,2026-10-24,2026-10-26,1.00,40.00,USD,40.00,2026-01-01');
    expect(lines).toContain('money emp,emp@money.test,2026-10-24,2026-10-26,0.33,50.00,USD,16.50,2026-10-26');
    expect(lines).toContain('money emp2,emp2@money.test,2026-10-24,2026-10-26,0.50,30.00,USD,15.00,2026-01-01');
    // The list never hands out download links (each link is an audited single read).
    expect((await adm.get('/v1/admin/payroll-exports')).body.items[0].download_url).toBeNull();
  });

  it('keeps rate history: started rates cannot change or be deleted, future ones can be deleted', async () => {
    const rates = await org.admin.get(`/v1/admin/rates/pay?user_id=${org.users.emp!.id}`);
    expect(rates.body.items.map((r: { effective_from: string }) => r.effective_from)).toEqual(['2026-10-26', '2026-01-01']);
    const started = rates.body.items[0].id;
    const del = await org.admin.req('DELETE', `/v1/admin/rates/pay/${started}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('rate_in_effect');
    await expect(withScope(org.id, () => env.deps.pool.query('UPDATE pay_rates SET amount_cents = 1 WHERE id = $1', [started]))).rejects.toThrow(/append-only/);
    const future = await org.admin.post('/v1/admin/rates/pay', { user_id: org.users.emp!.id, amount_cents: 6000, effective_from: '2027-01-01' });
    expect((await org.admin.req('DELETE', `/v1/admin/rates/pay/${future.body.id}`)).status).toBe(200);
  });

  it('employees see their own pay rate only, and reads by others are audited', async () => {
    const mine = await org.users.emp!.client.get('/v1/me/pay-rate');
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ current: { amount_cents: 5000, currency: 'USD', effective_from: '2026-10-26' }, upcoming: null });
    const theirs = await org.users.manager!.client.get('/v1/me/pay-rate');
    expect(theirs.body).toEqual({ current: null, upcoming: null });
    expect((await org.users.emp2!.client.get(`/v1/admin/rates/pay?user_id=${org.users.emp!.id}`)).status).toBe(403);
    expect((await org.users.manager!.client.get('/v1/admin/rates/pay')).status).toBe(403);

    // The admin reads above (list, payroll download link) appear in emp's "who viewed my data".
    const log = await org.users.emp!.client.get('/v1/me/access-log');
    const views = log.body.items.filter((e: { action: string }) => e.action === 'pay_rate.view');
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.some((e: { metadata: { via?: string } }) => e.metadata.via === 'payroll_export')).toBe(true);
    // Changes are audited without the amount.
    const changes = await org.admin.get('/v1/audit-events?action=pay_rate.create');
    expect(changes.body.items.length).toBeGreaterThanOrEqual(3);
    expect(changes.body.items.every((e: { metadata: Record<string, unknown> }) => !('amount_cents' in e.metadata))).toBe(true);
  });
});

describe('invoices', () => {
  beforeAll(async () => {
    const c = await org.admin.post('/v1/admin/clients', { name: 'Acme', contact_email: 'ap@acme.test', currency: 'USD', address: '1 Main St' });
    expect(c.status).toBe(201);
    clientId = c.body.id;
    expect((await org.admin.put(`/v1/admin/projects/${org.projectId}/client`, { client_id: clientId })).status).toBe(200);
  });

  it('drafts lines per project and bill rate, with tax and rounding', async () => {
    const r = await org.admin.post('/v1/admin/invoices', {
      client_id: clientId,
      period_from: '2026-10-01',
      period_to: '2026-10-31',
      timezone: 'UTC',
      tax_rate_bp: 825,
    });
    expect(r.status).toBe(201);
    const inv = r.body;
    expect(inv).toMatchObject({ status: 'draft', number: null, currency: 'USD', client_name: 'Acme', unrated_seconds: 0 });
    // Default rate $100: emp 60 min + emp2 30 min manual = 1.50 h; emp's own $150 rate from Oct 26: 20 min = 0.33 h.
    expect(inv.lines.map((l: { hours: number; rate_cents: number; amount_cents: number }) => [l.hours, l.rate_cents, l.amount_cents])).toEqual([
      [0.33, 15_000, 4950],
      [1.5, 10_000, 15_000],
    ]);
    expect(inv).toMatchObject({ subtotal_cents: 19_950, tax_cents: 1646, total_cents: 21_596 }); // 1645.875 → 1646

    const byPerson = await org.admin.post('/v1/admin/invoices', {
      client_id: clientId,
      period_from: '2026-10-01',
      period_to: '2026-10-31',
      timezone: 'UTC',
      group_by: 'project_person',
    });
    expect(byPerson.body.lines).toHaveLength(3);
    expect(byPerson.body.lines.every((l: { user_name: string | null }) => l.user_name)).toBe(true);
    expect(byPerson.body.total_cents).toBe(19_950);
    expect((await org.admin.req('DELETE', `/v1/admin/invoices/${byPerson.body.id}`)).status).toBe(200);
  });

  it('edits drafts, then issuing numbers and locks the invoice; void keeps the number', async () => {
    const draft = (await org.admin.get('/v1/admin/invoices')).body.items.find((i: { status: string }) => i.status === 'draft');
    const edited = await org.admin.put(`/v1/admin/invoices/${draft.id}/lines`, {
      lines: [
        { project_id: org.projectId, description: 'Design', hours: 2.5, rate_cents: 12_000 },
        { description: 'Setup fee', hours: 1, rate_cents: 3333 },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ subtotal_cents: 33_333, tax_cents: 2750, total_cents: 36_083 });
    const patched = await org.admin.req('PATCH', `/v1/admin/invoices/${draft.id}`, { tax_rate_bp: 0, notes: 'Thanks!' });
    expect(patched.body).toMatchObject({ tax_cents: 0, total_cents: 33_333, notes: 'Thanks!' });

    const issued = await org.admin.post(`/v1/admin/invoices/${draft.id}/issue`, { due_date: '2026-11-25' });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ status: 'issued', number: 'INV-2026-0001', due_date: '2026-11-25' });
    expect((await org.admin.put(`/v1/admin/invoices/${draft.id}/lines`, { lines: [] })).body.error.code).toBe('invoice_locked');
    expect((await org.admin.req('PATCH', `/v1/admin/invoices/${draft.id}`, { notes: 'x' })).status).toBe(409);
    expect((await org.admin.req('DELETE', `/v1/admin/invoices/${draft.id}`)).status).toBe(409);
    expect((await org.admin.post(`/v1/admin/invoices/${draft.id}/issue`)).status).toBe(409);
    // The database refuses changes too.
    await expect(withScope(org.id, () => env.deps.pool.query('UPDATE invoices SET total_cents = 1 WHERE id = $1', [draft.id]))).rejects.toThrow(/only be voided/);
    await expect(withScope(org.id, () => env.deps.pool.query('UPDATE invoice_lines SET hours = 9 WHERE invoice_id = $1', [draft.id]))).rejects.toThrow(/locked/);

    const raw = await env.app.inject({ method: 'GET', url: `/v1/admin/invoices/${draft.id}/csv`, headers: { cookie: org.admin.cookie } });
    expect(raw.headers['content-type']).toMatch(/text\/csv/);
    expect(raw.headers['content-disposition']).toContain('INV-2026-0001.csv');
    expect(raw.body).toContain('INV-2026-0001,issued,Acme,2026-10-01,2026-10-31,,,Total,,,333.33,USD');

    // Numbers are sequential per organization; voiding never frees a number.
    const second = await org.admin.post('/v1/admin/invoices', { client_id: clientId, period_from: '2026-10-25', period_to: '2026-10-26', timezone: 'UTC' });
    const voided = await org.admin.post(`/v1/admin/invoices/${draft.id}/void`, { reason: 'Sent to the wrong contact' });
    expect(voided.body).toMatchObject({ status: 'void', number: 'INV-2026-0001', void_reason: 'Sent to the wrong contact' });
    expect((await org.admin.post(`/v1/admin/invoices/${draft.id}/void`)).status).toBe(409);
    expect((await org.admin.post(`/v1/admin/invoices/${second.body.id}/void`)).body.error.code).toBe('invoice_not_issued');
    expect((await org.admin.post(`/v1/admin/invoices/${second.body.id}/issue`)).body.number).toBe('INV-2026-0002');
    const otherClient = await other.admin.post('/v1/admin/clients', { name: 'Elsewhere' });
    const theirLines = [{ description: 'Work', hours: 1, rate_cents: 100 }];
    const theirs = await other.admin.post('/v1/admin/invoices', { client_id: otherClient.body.id, period_from: '2026-10-01', period_to: '2026-10-31' });
    await other.admin.put(`/v1/admin/invoices/${theirs.body.id}/lines`, { lines: theirLines });
    expect((await other.admin.post(`/v1/admin/invoices/${theirs.body.id}/issue`)).body.number).toBe('INV-2026-0001');
  });
});

describe('budgets', () => {
  let s2: string; // emp2's session that keeps running while the budget runs out

  beforeAll(async () => {
    const p = await org.admin.post('/v1/admin/projects', { name: 'Budgeted' });
    budgetProjectId = p.body.id;
    await org.admin.post(`/v1/admin/projects/${budgetProjectId}/members`, { user_id: org.users.manager!.id, role: 'manager' });
  });

  const budgetNotes = async (userKey: 'manager' | 'emp') =>
    (await org.users[userKey]!.client.get('/v1/me/notifications')).body.items.filter((n: { kind: string }) => n.kind === 'project_budget');
  const adminNotes = async () => (await org.admin.get('/v1/me/notifications')).body.items.filter((n: { kind: string }) => n.kind === 'project_budget');

  it('alerts admins and project managers once per threshold', async () => {
    s2 = randomUUID();
    const start = await sendBatch(env, dev2, [event(dev2, s2, 'session.started.v1', { project_id: budgetProjectId }, '2026-10-26T10:00:00.000Z')]);
    expect(start.body.results[0].status).toBe('accepted');
    await session(dev, budgetProjectId, '2026-10-26T10:00:00.000Z', 40);

    const put = await org.admin.put(`/v1/projects/${budgetProjectId}/budget`, {
      kind: 'hours',
      limit_hours: 1,
      alert_thresholds: [50, 100],
      stop_at_budget: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.budget).toMatchObject({ used_seconds: 2400, used_percent: 66.6, status: 'near', limit_hours: 1 });
    expect(await budgetNotes('manager')).toHaveLength(1);
    expect((await budgetNotes('manager'))[0].title).toBe('Budgeted has used 50% of its budget');
    expect(await adminNotes()).toHaveLength(1);
    expect(await budgetNotes('emp')).toHaveLength(0); // employees are not told

    expect(await checkAllBudgets(env.deps)).toBe(0); // already sent for this period
    await session(dev, budgetProjectId, '2026-10-26T11:00:00.000Z', 25);
    expect(await checkAllBudgets(env.deps)).toBe(2); // admin + project manager
    expect(await checkAllBudgets(env.deps)).toBe(0);
    const notes = await budgetNotes('manager');
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe('Budgeted has reached its budget');
    expect(notes[0].body).toContain('Sessions already running are not stopped');
  });

  it('stop at budget refuses new sessions on the project but never stops a running one', async () => {
    const blocked = await session(dev, budgetProjectId, '2026-10-26T12:00:00.000Z', 2);
    expect(blocked.results[0]).toMatchObject({ status: 'rejected', reason: 'project_budget_reached' });
    expect(await count('SELECT count(*) AS n FROM work_sessions WHERE id = $1', [blocked.sid])).toBe(0);
    const rest = await env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { session_id: randomUUID(), project_id: budgetProjectId },
      headers: { authorization: `Device ${dev.credential}` },
    });
    expect(rest.statusCode).toBe(409);
    expect(JSON.parse(rest.body).error.code).toBe('project_budget_reached');
    // Other projects are unaffected.
    const elsewhere = await session(dev, org.projectId, '2026-10-26T12:10:00.000Z', 1);
    expect(elsewhere.results[0]!.status).toBe('accepted');

    // emp2's session started before the budget ran out: it keeps recording.
    const more = await sendBatch(env, dev2, minutes('2026-10-26T12:00:00.000Z', 3).map((m) => bucket(dev2, s2, m)));
    expect(more.body.results.every((r: { status: string }) => r.status === 'accepted')).toBe(true);
    await env.drain();
    expect(await count(`SELECT count(*) AS n FROM work_sessions WHERE id = $1 AND state = 'active'`, [s2])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM activity_buckets WHERE session_id = $1', [s2])).toBe(3);

    // A higher limit is a new budget: new sessions are allowed again and thresholds re-arm.
    await org.admin.put(`/v1/projects/${budgetProjectId}/budget`, { kind: 'hours', limit_hours: 10, alert_thresholds: [50, 100], stop_at_budget: true });
    const allowed = await session(dev, budgetProjectId, '2026-10-26T12:30:00.000Z', 1);
    expect(allowed.results[0]!.status).toBe('accepted');
  });

  it('project managers read their budgets; employees and other tenants cannot', async () => {
    const pm = await org.users.manager!.client.get(`/v1/projects/${budgetProjectId}/budget`);
    expect(pm.status).toBe(200);
    expect(pm.body.budget).toMatchObject({ kind: 'hours', limit_hours: 10, status: 'ok', stop_at_budget: true });
    expect((await org.users.manager!.client.put(`/v1/projects/${budgetProjectId}/budget`, { kind: 'hours', limit_hours: 99 })).status).toBe(403);
    expect((await org.users.emp!.client.get(`/v1/projects/${budgetProjectId}/budget`)).status).toBe(403);
    expect((await other.admin.get(`/v1/projects/${budgetProjectId}/budget`)).status).toBe(404);
    expect((await org.admin.get(`/v1/projects/${org.projectId}/budget`)).body).toEqual({ budget: null });

    // Amount budgets value time at bill rates in the budget currency.
    const amount = await org.admin.put(`/v1/projects/${org.projectId}/budget`, { kind: 'amount', limit_cents: 100_000, currency: 'USD', resets: 'monthly' });
    // emp 1.00 h @ $100, emp2 0.50 h @ $100, emp 21 min = 0.35 h @ $150
    expect(amount.body.budget).toMatchObject({ kind: 'amount', used_cents: 10_000 + 5000 + 5250, unrated_seconds: 0, period: { key: '2026-10' } });
  });
});

describe('tenant isolation', () => {
  it('other organizations cannot see or touch money records', async () => {
    const invoices = (await org.admin.get('/v1/admin/invoices')).body.items;
    expect((await other.admin.get(`/v1/admin/invoices/${invoices[0].id}`)).status).toBe(404);
    expect((await other.admin.post(`/v1/admin/invoices/${invoices[0].id}/void`)).status).toBe(404);
    expect((await other.admin.put(`/v1/admin/projects/${org.projectId}/client`, { client_id: null })).status).toBe(404);
    expect((await other.admin.post('/v1/admin/rates/pay', { user_id: org.users.emp!.id, amount_cents: 1, effective_from: '2026-01-01' })).status).toBe(404);
    expect((await other.admin.post('/v1/admin/invoices', { client_id: clientId, period_from: '2026-10-01', period_to: '2026-10-31' })).status).toBe(404);
    expect((await other.admin.get('/v1/admin/rates/pay')).body.items).toEqual([]);
    expect((await other.admin.get('/v1/admin/clients')).body.items.map((c: { name: string }) => c.name)).toEqual(['Elsewhere']);
    expect((await other.admin.get('/v1/admin/invoices/not-a-uuid')).status).toBe(404);

    // Row-level security: an unfiltered query in another tenant's scope sees nothing of ours.
    for (const table of ['clients', 'pay_rates', 'bill_rates', 'project_budgets', 'budget_alerts_sent', 'invoices', 'invoice_lines', 'payroll_exports']) {
      const r = await withScope(other.id, () => env.deps.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [org.id]));
      expect(r.rows[0].n, table).toBe(0);
      if (table === 'budget_alerts_sent') continue; // re-armed when the limit was raised
      const mine = await withScope(org.id, () => env.deps.pool.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(mine.rows[0].n, table).toBeGreaterThan(0);
    }
    await expect(
      withScope(other.id, () => env.deps.pool.query(`INSERT INTO clients (organization_id, name) VALUES ($1, 'Intruder')`, [org.id])),
    ).rejects.toThrow(/row-level security/);
  });
});
