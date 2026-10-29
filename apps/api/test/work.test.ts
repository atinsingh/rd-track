import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { dueAt, reminderAt, runDeviceHealth, runTimesheetRules, workingDaysBetween } from '../src/modules/engine/work';
import { bucket, enrollDevice, event, login, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Engine slice 3: inbox counts, to-dos, the timesheet deadline rule, device health, webhooks. */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  process.env.WEBHOOKS_ALLOW_PRIVATE = 'true';
  env = await testEnv();
});

const manual = (day: string) => ({ requested: { started_at: `${day}T08:00:00Z`, ended_at: `${day}T08:30:00Z`, project_id: null }, reason: 'Forgot the timer' });
const kinds = async (org: Org, who: string) =>
  ((await (who === 'admin' ? org.admin : org.users[who]!.client).get('/v1/me/notifications')).body.items as { kind: string; title: string; link: string }[]);

async function trackWeek(org: Org, who: string, day: string) {
  const d = await enrollDevice(env, org, who);
  const sid = randomUUID();
  await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, `${day}T09:00:00Z`), ...minutes(`${day}T09:00:00Z`, 30).map((m) => bucket(d, sid, m))]);
  await env.drain();
  return d;
}

describe('inbox counts', () => {
  it('counts what waits on each reviewer, never their own', async () => {
    env.clock.t = new Date('2026-11-03T12:00:00Z').getTime();
    const org = await makeOrg(env, 'wk1', 'standard');
    await org.users.emp!.client.post('/v1/me/time-corrections', manual('2026-10-27'));
    await org.users.manager!.client.post('/v1/me/time-corrections', manual('2026-10-28'));
    await trackWeek(org, 'emp2', '2026-10-27');
    expect((await org.users.emp2!.client.post('/v1/me/timesheets/2026-10-26/submit', {})).status).toBe(200);

    expect((await org.users.manager!.client.get('/v1/inbox/counts')).body).toEqual({ corrections: 1, timesheets: 1, time_off: 0, deletion_requests: 0, total: 2 });
    // Admins review everyone (including the manager's own correction).
    expect((await org.admin.get('/v1/inbox/counts')).body).toMatchObject({ corrections: 2, timesheets: 1, total: 3 });
    expect((await org.users.emp!.client.get('/v1/inbox/counts')).body.total).toBe(0);
  });

  it('deletion requests are decided in the same batch, by org admins only', async () => {
    const org = await makeOrg(env, 'wk2');
    const r = await org.users.manager!.client.post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'deletion_request', id: randomUUID() }] });
    expect(r.body.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    const a = await org.admin.post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'deletion_request', id: randomUUID() }] });
    expect(a.body.results[0]).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('time off from someone without a team manager reaches the org admins', async () => {
    const org = await makeOrg(env, 'wk3');
    const p = await org.admin.post('/v1/admin/time-off/policies', { name: 'Vacation', kind: 'paid' });
    await org.admin.post('/v1/admin/time-off/assignments', { policy_id: p.body.id, user_id: org.users.manager!.id, start_date: '2026-01-01', opening_balance_hours: 40 });
    const req = await org.users.manager!.client.post('/v1/me/time-off/requests', { policy_id: p.body.id, start_date: '2026-11-20', end_date: '2026-11-20' });
    expect(req.status).toBe(201);
    expect((await kinds(org, 'admin')).map((n) => n.kind)).toContain('time_off_request');
  });
});

describe('timesheet deadline rule', () => {
  it('is off by default; admins set it', async () => {
    const org = await makeOrg(env, 'rule0', 'standard');
    expect((await org.admin.get('/v1/admin/timesheet-rule')).body).toEqual({ enabled: false, due_weekday: 1, due_time: '10:00', escalate_after_hours: 24 });
    expect((await org.users.manager!.client.get('/v1/admin/timesheet-rule')).status).toBe(403);
    expect((await org.admin.req('PUT', '/v1/admin/timesheet-rule', { enabled: true, due_weekday: 1, due_time: '25:00', escalate_after_hours: 24 })).status).toBe(400);
  });

  it('reminds before, tells the person when overdue, then sends the reviewer one digest', async () => {
    env.clock.t = new Date('2026-10-28T12:00:00Z').getTime();
    const org = await makeOrg(env, 'rule1', 'standard');
    await org.admin.req('PUT', '/v1/admin/timesheet-rule', { enabled: true, due_weekday: 1, due_time: '10:00', escalate_after_hours: 24 });
    await trackWeek(org, 'emp', '2026-10-27');
    const run = () => withScope(SYSTEM_SCOPE, () => runTimesheetRules(env.deps));
    const relogin = async () => {
      for (const who of ['emp', 'emp2', 'manager']) org.users[who]!.client = await login(env.app, `${who}@rule1.test`);
    };

    // Due Monday 2 Nov 10:00; the reminder would be Sunday, so it moves to Friday 10:00.
    env.clock.t = new Date('2026-10-30T12:00:00Z').getTime();
    await relogin();
    await run();
    await run();
    let emp = await kinds(org, 'emp');
    expect(emp.filter((n) => n.kind === 'timesheet_due').map((n) => n.title)).toEqual(['Your timesheet for the week of 26 Oct is due Mon 2 Nov, 10:00']);
    // emp2 tracked nothing that week: never chased.
    expect((await kinds(org, 'emp2')).filter((n) => n.kind.startsWith('timesheet'))).toEqual([]);
    const todo = (await org.users.emp!.client.get('/v1/me/todos')).body.items[0];
    expect(todo).toMatchObject({ kind: 'submit_timesheet', due_at: '2026-11-02T10:00:00.000Z', overdue: false });

    env.clock.t = new Date('2026-11-02T11:00:00Z').getTime();
    await relogin();
    await run();
    emp = await kinds(org, 'emp');
    expect(emp.map((n) => n.kind)).toContain('timesheet_overdue');
    expect((await org.users.emp!.client.get('/v1/me/todos')).body.items[0]).toMatchObject({ overdue: true });

    env.clock.t = new Date('2026-11-03T11:00:00Z').getTime();
    await relogin();
    await run();
    await run();
    const digest = (await kinds(org, 'manager')).filter((n) => n.kind === 'timesheet_escalated');
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ title: '1 timesheet is overdue for the week of 26 Oct', link: '/team' });

    // Submitting clears the to-do.
    expect((await org.users.emp!.client.post('/v1/me/timesheets/2026-10-26/submit', {})).status).toBe(200);
    expect((await org.users.emp!.client.get('/v1/me/todos')).body.items).toEqual([]);
  });

  it('works out the due time and reminder in the person’s zone', () => {
    const rule = { due_weekday: 1, due_time: '10:00' };
    // Monday 2 Nov 10:00 EST; the reminder is Friday 10:00, still EDT (the clocks change on 1 Nov).
    expect(new Date(dueAt(rule, '2026-10-26', 'America/Toronto')).toISOString()).toBe('2026-11-02T15:00:00.000Z');
    expect(new Date(reminderAt(rule, '2026-10-26', 'America/Toronto')).toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(new Date(reminderAt({ due_weekday: 3, due_time: '17:00' }, '2026-10-26', 'UTC')).toISOString()).toBe('2026-11-03T17:00:00.000Z');
  });
});

describe('device health', () => {
  it('counts working days, so a weekend is not "stale"', () => {
    expect(workingDaysBetween(Date.parse('2026-10-30T17:00:00Z'), Date.parse('2026-11-02T09:00:00Z'))).toBe(1);
    expect(workingDaysBetween(Date.parse('2026-10-28T17:00:00Z'), Date.parse('2026-11-02T09:00:00Z'))).toBe(3);
  });

  it('nudges the owner once per quiet stretch, and lists it as a to-do', async () => {
    env.clock.t = new Date('2026-11-02T12:00:00Z').getTime();
    const org = await makeOrg(env, 'dev1');
    const d = await enrollDevice(env, org, 'emp');
    await env.deps.pool.query(`UPDATE devices SET last_seen_at = '2026-10-27T16:00:00Z' WHERE id = $1`, [d.id]);
    const run = () => withScope(SYSTEM_SCOPE, () => runDeviceHealth(env.deps));
    await run();
    await run();
    const notes = (await kinds(org, 'emp')).filter((n) => n.kind === 'device_stale');
    expect(notes.map((n) => n.title)).toEqual(['Test laptop hasn’t synced for a few working days']);
    expect((await kinds(org, 'admin')).filter((n) => n.kind === 'device_stale')).toEqual([]);
    expect((await org.users.emp!.client.get('/v1/me/todos')).body.items.map((t: { kind: string }) => t.kind)).toContain('open_agent');
  });
});

describe('webhooks from engine events', () => {
  it('delivers subscribed events with ids only', async () => {
    env.clock.t = new Date('2026-11-03T12:00:00Z').getTime();
    const org = await makeOrg(env, 'hook1', 'pro');
    const created = await org.admin.post('/v1/admin/webhooks', {
      url: 'https://hooks.example.com/rd',
      events: ['time_correction.submitted', 'time_correction.rejected', 'user.invited', 'user.deactivated', 'timesheet.submitted', 'timesheet.approved'],
    });
    expect(created.status).toBe(201);
    const c = await org.users.emp!.client.post('/v1/me/time-corrections', manual('2026-10-27'));
    await org.users.manager!.client.post(`/v1/corrections/${c.body.id}/reject`, { note: 'Which client?' });
    const invited = await org.admin.post('/v1/admin/users', { email: 'new@hook1.test', display_name: 'New' });
    await org.admin.post(`/v1/admin/users/${invited.body.user.id}/deactivate`, {});
    await trackWeek(org, 'emp2', '2026-10-27');
    const ts = await org.users.emp2!.client.post('/v1/me/timesheets/2026-10-26/submit', {});
    await org.users.manager!.client.post(`/v1/timesheets/${ts.body.id}/approve`, {});

    const rows = await withScope(org.id, () =>
      env.deps.pool.query(`SELECT event_type, payload FROM webhook_deliveries WHERE organization_id = $1 ORDER BY created_at, event_type`, [org.id]),
    );
    expect(rows.rows.map((r) => r.event_type).sort()).toEqual(
      ['time_correction.rejected', 'time_correction.submitted', 'timesheet.approved', 'timesheet.submitted', 'user.deactivated', 'user.invited'].sort(),
    );
    const sub = rows.rows.find((r) => r.event_type === 'time_correction.submitted')!.payload;
    expect(sub.data).toEqual({ user_id: org.users.emp!.id, correction_id: c.body.id });
    expect(JSON.stringify(rows.rows)).not.toContain('Forgot the timer');
    expect(JSON.stringify(rows.rows)).not.toContain('Which client?');
  });
});
