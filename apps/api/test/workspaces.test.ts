import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
import { bucket, enrollDevice, event, login, makeOrg, minutes, sendBatch, testEnv, PASSWORD, type Org, type TestEnv } from './helpers';

/** Engine slice 4: the finance role, role homes, invoice payment and delivery, auditor tools. */

let env: TestEnv;
let org: Org;
let finance: Awaited<ReturnType<typeof login>>;
let auditor: Awaited<ReturnType<typeof login>>;

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-04T15:00:00Z').getTime();
  org = await makeOrg(env, 'ws');
  for (const [key, role] of [['finance', 'finance'], ['auditor', 'auditor']] as const) {
    const r = await org.admin.post('/v1/admin/users', { email: `${key}@ws.test`, display_name: `ws ${key}`, org_role: role, tracking_enabled: false, password: PASSWORD });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  finance = await login(env.app, 'finance@ws.test');
  auditor = await login(env.app, 'auditor@ws.test');
});

describe('finance role', () => {
  it('runs Money without admin: reads people and projects, changes neither', async () => {
    for (const url of ['/v1/admin/clients', '/v1/admin/invoices', '/v1/admin/rates/pay', '/v1/admin/budgets', '/v1/admin/payroll-exports', '/v1/money/overview', '/v1/admin/users', '/v1/admin/projects']) {
      expect((await finance.get(url)).status, url).toBe(200);
    }
    for (const url of ['/v1/admin/overview', '/v1/audit-events', '/v1/policies', '/v1/admin/devices', '/v1/billing/subscription']) {
      expect((await finance.get(url)).status, url).toBe(403);
    }
    expect((await finance.post('/v1/admin/users', { email: 'x@ws.test', display_name: 'X' })).status).toBe(403);
    expect((await finance.post('/v1/admin/projects', { name: 'Nope' })).status).toBe(403);
    // Employees and managers still can't.
    expect((await org.users.manager!.client.get('/v1/money/overview')).status).toBe(403);
  });

  it('records payment and sends issued invoices to the client, without touching what was billed', async () => {
    const c = await finance.post('/v1/admin/clients', { name: 'Acme', contact_email: 'ap@acme.test', currency: 'USD' });
    expect(c.status).toBe(201);
    const draft = await finance.post('/v1/admin/invoices', { client_id: c.body.id, period_from: '2026-10-01', period_to: '2026-10-31', timezone: 'UTC' });
    await finance.put(`/v1/admin/invoices/${draft.body.id}/lines`, { lines: [{ description: 'Design', hours: 2, rate_cents: 10_000 }] });
    expect((await finance.post(`/v1/admin/invoices/${draft.body.id}/paid`, { paid_on: '2026-11-04' })).body.error.code).toBe('invoice_not_issued');
    expect((await finance.post(`/v1/admin/invoices/${draft.body.id}/send`, {})).body.error.code).toBe('invoice_not_issued');
    await finance.post(`/v1/admin/invoices/${draft.body.id}/issue`, { due_date: '2026-11-03' });

    let overview = (await finance.get('/v1/money/overview')).body;
    expect(overview.period).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(overview.open_invoices.map((i: { id: string; paid_on: string | null }) => [i.id, i.paid_on])).toEqual([[draft.body.id, null]]);

    const before = env.email.sent.length;
    const sent = await finance.post(`/v1/admin/invoices/${draft.body.id}/send`, { message: 'Thanks for the project!' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ sent_to: 'ap@acme.test' });
    expect(sent.body.sent_at).toBeTruthy();
    const mail = env.email.sent[before]!;
    expect(mail).toMatchObject({ to: 'ap@acme.test', replyTo: 'finance@ws.test', subject: `Invoice ${sent.body.number} from ws Inc` });
    expect(mail.text).toContain('Total: $200.00');
    expect(mail.text).toContain('Thanks for the project!');
    expect((await finance.post(`/v1/admin/invoices/${draft.body.id}/send`, { to: 'billing@acme.test' })).body.sent_to).toBe('billing@acme.test');

    const paid = await finance.post(`/v1/admin/invoices/${draft.body.id}/paid`, { paid_on: '2026-11-04', note: 'Wire 4411' });
    expect(paid.body).toMatchObject({ status: 'issued', paid_on: '2026-11-04', payment_note: 'Wire 4411', total_cents: 20_000 });
    overview = (await finance.get('/v1/money/overview')).body;
    expect(overview.open_invoices).toEqual([]);
    expect(overview.paid_this_period).toEqual({ count: 1, by_currency: [{ currency: 'USD', total_cents: 20_000 }] });
    // The amounts stay locked in the database.
    await expect(withScope(org.id, () => env.deps.pool.query('UPDATE invoices SET total_cents = 1 WHERE id = $1', [draft.body.id]))).rejects.toThrow(/voided/);

    const undone = await finance.req('DELETE', `/v1/admin/invoices/${draft.body.id}/paid`);
    expect(undone.body).toMatchObject({ paid_on: null, payment_note: null });
    // A void invoice can't be marked paid.
    await finance.post(`/v1/admin/invoices/${draft.body.id}/void`, { reason: 'Wrong client' });
    expect((await finance.post(`/v1/admin/invoices/${draft.body.id}/paid`, { paid_on: '2026-11-04' })).status).toBe(409);

    const log = (await org.admin.get('/v1/audit-events?action=invoice.')).body.items.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(['invoice.send', 'invoice.paid', 'invoice.unpaid']));
  });

  it('lists what has not been invoiced yet per client', async () => {
    const c = await org.admin.post('/v1/admin/clients', { name: 'Globex', currency: 'USD' });
    await org.admin.put(`/v1/admin/projects/${org.projectId}/client`, { client_id: c.body.id });
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [
      event(d, sid, 'session.started.v1', { project_id: org.projectId }, '2026-11-02T14:00:00Z'),
      ...minutes('2026-11-02T14:00:00Z', 30).map((m) => bucket(d, sid, m)),
    ]);
    await env.drain();
    const unbilled = (await finance.get('/v1/money/overview')).body.unbilled;
    expect(unbilled).toEqual([{ client_id: c.body.id, client_name: 'Globex', since: '2026-08-06', seconds: 1800 }]);
  });
});

describe('admin overview', () => {
  it('builds the setup checklist from the data', async () => {
    const fresh = await makeOrg(env, 'ws2');
    const steps = async () =>
      Object.fromEntries(((await fresh.admin.get('/v1/admin/overview')).body.setup as { key: string; done: boolean }[]).map((s) => [s.key, s.done]));
    expect(await steps()).toMatchObject({ invite_people: true, create_team: true, connect_computer: false, turn_on_mfa: false, timesheet_deadline: false });
    await enrollDevice(env, fresh, 'emp');
    await fresh.admin.put('/v1/admin/timesheet-rule', { enabled: true, due_weekday: 1, due_time: '10:00', escalate_after_hours: 24 });
    expect(await steps()).toMatchObject({ connect_computer: true, timesheet_deadline: true });
    expect((await fresh.users.manager!.client.get('/v1/admin/overview')).status).toBe(403);
  });

  it('shows team hours only for teams of five or more', async () => {
    const o = await makeOrg(env, 'ws3');
    const d = await enrollDevice(env, o, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, '2026-11-03T14:00:00Z'), ...minutes('2026-11-03T14:00:00Z', 20).map((m) => bucket(d, sid, m))]);
    await env.drain();
    let week = (await o.admin.get('/v1/admin/overview')).body.week;
    expect(week).toMatchObject({ week: '2026-11-02', tracked_seconds: 1200, people_tracked: 1 });
    expect(week.teams).toEqual([{ id: o.teamId, name: 'ws3 Team', members: 3, tracked_seconds: null }]);
    for (const n of ['a', 'b']) {
      const u = await o.admin.post('/v1/admin/users', { email: `${n}@ws3.test`, display_name: n, password: PASSWORD });
      await o.admin.post(`/v1/admin/teams/${o.teamId}/members`, { user_id: u.body.user.id, role: 'member' });
    }
    week = (await o.admin.get('/v1/admin/overview')).body.week;
    expect(week.teams[0]).toMatchObject({ members: 5, tracked_seconds: 1200 });
    const people = (await o.admin.get('/v1/admin/overview')).body.people;
    expect(people).toMatchObject({ active: 6, invited: 0 });
    expect(people.without_reviewer).toBeGreaterThanOrEqual(1);
  });
});

describe('auditor tools', () => {
  it('filters by whose data it was, lists names only, and exports CSV that is itself audited', async () => {
    const empId = org.users.emp!.id;
    await org.users.manager!.client.get(`/v1/users/${empId}/sessions?from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z`);
    const about = (await auditor.get(`/v1/audit-events?subject_id=${empId}`)).body.items as { target_user_id: string }[];
    expect(about.length).toBeGreaterThan(0);
    expect(about.every((e) => e.target_user_id === empId)).toBe(true);

    const people = (await auditor.get('/v1/audit-events/people')).body.items as Record<string, unknown>[];
    expect(people.find((p) => p.id === empId)).toEqual({ id: empId, display_name: 'ws emp', status: 'active' });
    expect(people.every((p) => !('email' in p))).toBe(true);
    expect((await org.users.emp!.client.get('/v1/audit-events/people')).status).toBe(403);

    const raw = await env.app.inject({ method: 'GET', url: `/v1/audit-events/export?subject_id=${empId}`, headers: { cookie: auditor.cookie } });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toMatch(/text\/csv/);
    expect(raw.headers['x-rd-truncated']).toBe('0');
    expect(raw.body.split(/\r?\n/)[0]).toBe('time_utc,actor_type,actor,actor_id,action,target_type,target_id,about_user_id,result,request_id');
    expect((await auditor.get('/v1/audit-events?action=audit.export')).body.items[0]).toMatchObject({ action: 'audit.export' });
  });
});
