import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
import { bucket, enrollDevice, event, login, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/**
 * Weekly timesheets: submit → approve/reject/reopen, approval locks the week against
 * corrections, limits and overtime, plan gate and tenant isolation.
 *
 * The employee works in America/Toronto. DST ends there on Sunday 1 Nov 2026 (02:00 EDT →
 * 01:00 EST), so the week of Mon 26 Oct runs from 04:00Z on 26 Oct to 05:00Z on 2 Nov
 * (169 hours).
 */

const H = 3600;
let env: TestEnv;
let org: Org;
let agentSession: string;

const emp = () => org.users.emp!;
const emp2 = () => org.users.emp2!;
const manager = () => org.users.manager!;

async function addManual(userId: string, start: string, end: string, projectId: string | null = org.projectId) {
  const id = randomUUID();
  await env.deps.pool.query(
    `INSERT INTO work_sessions (id, organization_id, user_id, project_id, state, source, started_at, ended_at, stop_reason)
     VALUES ($1, $2, $3, $4, 'stopped', 'manual', $5, $6, 'manual')`,
    [id, org.id, userId, projectId, start, end],
  );
  return id;
}

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'ts');
  expect((await org.admin.req('PATCH', `/v1/admin/users/${emp().id}`, { timezone: 'America/Toronto' })).status).toBe(200);

  // 30 minutes of agent time on Tue 27 Oct (09:00 EDT).
  const dev = await enrollDevice(env, org, 'emp');
  agentSession = randomUUID();
  const start = '2026-10-27T13:00:00.000Z';
  env.clock.t = new Date('2026-10-27T13:31:00Z').getTime();
  const r = await sendBatch(env, dev, [
    event(dev, agentSession, 'session.started.v1', {}, start),
    ...minutes(start, 30).map((m) => bucket(dev, agentSession, m)),
    event(dev, agentSession, 'session.stopped.v1', { reason: 'user' }, '2026-10-27T13:30:00Z'),
  ]);
  expect(r.status).toBeLessThan(300);
  await env.drain();

  // Sun 1 Nov 23:30–24:00 EST: still the week of 26 Oct (a fixed EDT offset would say 2 Nov).
  await addManual(emp().id, '2026-11-02T04:30:00Z', '2026-11-02T05:00:00Z');
  // Mon 2 Nov 00:30–01:30 EST: the next week.
  await addManual(emp().id, '2026-11-02T05:30:00Z', '2026-11-02T06:30:00Z', null);
  // Sun 25 Oct 23:30 EDT: the week before.
  await addManual(emp().id, '2026-10-26T03:30:00Z', '2026-10-26T04:00:00Z');

  // A week later: sign everyone in again (sessions don't last that long).
  env.clock.t = new Date('2026-11-03T15:00:00Z').getTime();
  org.admin.cookie = (await login(env.app, 'admin@ts.test')).cookie;
  for (const name of Object.keys(org.users)) org.users[name]!.client.cookie = (await login(env.app, `${name}@ts.test`)).cookie;
});
afterAll(() => env.close());

describe('building a timesheet', () => {
  it('adds agent and approved manual time per day and project, with DST-safe week boundaries', async () => {
    const r = await emp().client.get('/v1/me/timesheets/2026-10-26');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: null, status: 'draft', timezone: 'America/Toronto', period_end: '2026-11-01', locked: false, can_submit: true });
    const t = r.body.totals;
    expect(t).toMatchObject({ total_seconds: H, tracked_seconds: 30 * 60, manual_seconds: 30 * 60, corrected_seconds: 0 });
    expect(t.days).toHaveLength(7);
    expect(t.days[1]).toMatchObject({ date: '2026-10-27', tracked_seconds: 1800 });
    expect(t.days[6]).toMatchObject({ date: '2026-11-01', manual_seconds: 1800 });
    expect(t.projects).toEqual([
      { project_id: org.projectId, project_name: 'ts Project', seconds: 1800 },
      { project_id: null, project_name: 'No project', seconds: 1800 },
    ]);

    const next = await emp().client.get('/v1/me/timesheets/2026-11-02');
    expect(next.body.totals.total_seconds).toBe(H);
    expect(next.body.totals.projects[0]).toMatchObject({ project_id: null, project_name: 'No project' });

    const list = await emp().client.get('/v1/me/timesheets?from=2026-10-19&to=2026-11-08');
    expect(list.body.items.map((w: { period_start: string; total_seconds: number }) => [w.period_start, w.total_seconds])).toEqual([
      ['2026-10-19', 1800],
      ['2026-10-26', H],
      ['2026-11-02', H],
    ]);
  });

  it('validates the period and range', async () => {
    expect((await emp().client.get('/v1/me/timesheets/2026-10-27')).status).toBe(400);
    expect((await emp().client.get('/v1/me/timesheets?from=2026-01-01&to=2026-12-31')).status).toBe(400);
    expect((await emp().client.post('/v1/me/timesheets/2026-11-09/submit')).status).toBe(400); // not started yet
  });
});

describe('submit and review', () => {
  let id: string;

  it('lets the employee submit, but not approve their own; other employees cannot review', async () => {
    const r = await emp().client.post('/v1/me/timesheets/2026-10-26/submit', { note: 'All good' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'submitted', can_submit: false, submitted_totals: { total_seconds: H } });
    id = r.body.id;
    expect((await emp().client.post('/v1/me/timesheets/2026-10-26/submit')).body.error.code).toBe('already_submitted');

    const own = await emp().client.post(`/v1/timesheets/${id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body.error.message).toMatch(/own/);
    expect((await emp2().client.post(`/v1/timesheets/${id}/approve`)).status).toBe(403);
    expect((await emp2().client.get(`/v1/users/${emp().id}/timesheets/2026-10-26`)).status).toBe(403);
  });

  it('a manager rejects with a note, the employee resubmits, the manager approves and the week locks', async () => {
    const pending = await manager().client.get('/v1/timesheets/pending');
    expect(pending.body.items.map((t: { id: string }) => t.id)).toEqual([id]);
    expect(pending.body.items[0]).toMatchObject({ user_name: 'ts emp', can_review: true, changed_since_submit: false });

    expect((await manager().client.post(`/v1/timesheets/${id}/reject`, {})).status).toBe(400);
    const rejected = await manager().client.post(`/v1/timesheets/${id}/reject`, { note: 'Please add Friday' });
    expect(rejected.body).toMatchObject({ status: 'rejected', note: 'Please add Friday', reviewer_name: 'ts manager' });
    expect((await manager().client.post(`/v1/timesheets/${id}/approve`)).body.error.code).toBe('invalid_timesheet_state');

    const notes = await emp().client.get('/v1/me/notifications');
    expect(notes.body.items[0]).toMatchObject({ kind: 'timesheet_review', title: expect.stringMatching(/sent back/) });

    expect((await emp().client.post('/v1/me/timesheets/2026-10-26/submit')).body.status).toBe('submitted');
    const approved = await manager().client.post(`/v1/timesheets/${id}/approve`, { note: 'Thanks' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', locked: true, approved_totals: { total_seconds: H } });
    expect(approved.body.events.map((e: { action: string }) => e.action)).toEqual(['submit', 'reject', 'submit', 'approve']);

    const view = await manager().client.get(`/v1/users/${emp().id}/timesheets/2026-10-26`);
    expect(view.body).toMatchObject({ status: 'approved', can_review: true });

    const log = await emp().client.get('/v1/me/access-log');
    const actions = log.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['timesheet.reject', 'timesheet.approve', 'timesheet.view']));
  });

  it('refuses corrections and manual time for a locked week until it is reopened', async () => {
    const manual = { requested: { started_at: '2026-10-28T14:00:00Z', ended_at: '2026-10-28T15:00:00Z', project_id: org.projectId }, reason: 'Client call' };
    const blocked = await emp().client.post('/v1/me/time-corrections', manual);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'timesheet_locked', details: { period_start: '2026-10-26' } });

    // Moving the agent session out of the locked week is refused too.
    const edit = await emp().client.post('/v1/me/time-corrections', {
      session_id: agentSession,
      requested: { started_at: '2026-11-03T13:00:00Z', ended_at: '2026-11-03T13:30:00Z', project_id: org.projectId },
      reason: 'Wrong day',
    });
    expect(edit.body.error.code).toBe('timesheet_locked');

    // A correction proposed before the week locked can't be approved into it.
    const early = await emp().client.post('/v1/me/time-corrections', {
      requested: { started_at: '2026-11-03T13:00:00Z', ended_at: '2026-11-03T14:00:00Z', project_id: org.projectId },
      reason: 'Workshop',
    });
    expect(early.status).toBe(201);
    const week2 = await emp().client.post('/v1/me/timesheets/2026-11-02/submit');
    expect((await manager().client.post(`/v1/timesheets/${week2.body.id}/approve`)).status).toBe(200);
    const late = await manager().client.post(`/v1/corrections/${early.body.id}/approve`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('timesheet_locked');

    expect((await emp().client.post(`/v1/timesheets/${id}/reopen`, { note: 'Fixing' })).status).toBe(403);
    expect((await manager().client.post(`/v1/timesheets/${id}/reopen`, {})).status).toBe(400);
    const reopened = await manager().client.post(`/v1/timesheets/${id}/reopen`, { note: 'Add the client call' });
    expect(reopened.body).toMatchObject({ status: 'reopened', locked: false, approved_totals: null, can_review: true });
    expect((await emp().client.post('/v1/me/time-corrections', manual)).status).toBe(201);

    // Corrected agent time counts the corrected span once approved.
    const fix = await emp().client.post('/v1/me/time-corrections', {
      session_id: agentSession,
      requested: { started_at: '2026-10-27T12:45:00Z', ended_at: '2026-10-27T13:30:00Z', project_id: org.projectId },
      reason: 'Started before the timer',
    });
    expect((await manager().client.post(`/v1/corrections/${fix.body.id}/approve`)).status).toBe(200);
    const after = await emp().client.get('/v1/me/timesheets/2026-10-26');
    expect(after.body.totals).toMatchObject({ tracked_seconds: 0, corrected_seconds: 45 * 60, manual_seconds: 1800 });

    const audit = await org.admin.get('/v1/audit-events?action=timesheet.');
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['timesheet.submit', 'timesheet.approve', 'timesheet.reject', 'timesheet.reopen']),
    );
    expect(audit.body.items.find((e: { action: string }) => e.action === 'timesheet.reopen').target_user_id).toBe(emp().id);
  });

  it('org admins can approve; a manager cannot approve their own timesheet', async () => {
    const mine = await manager().client.post('/v1/me/timesheets/2026-10-26/submit');
    expect(mine.status).toBe(200);
    expect((await manager().client.post(`/v1/timesheets/${mine.body.id}/approve`)).status).toBe(403);
    expect((await manager().client.get('/v1/timesheets/pending')).body.items.map((t: { id: string }) => t.id)).not.toContain(mine.body.id);
    expect((await org.admin.get('/v1/timesheets/pending')).body.items.map((t: { id: string }) => t.id)).toContain(mine.body.id);
    expect((await org.admin.post(`/v1/timesheets/${mine.body.id}/approve`)).body.status).toBe('approved');
  });
});

describe('work limits and overtime', () => {
  beforeAll(async () => {
    // emp2 (UTC) works 9h a day Monday–Friday in the week of 26 Oct = 45h.
    for (let d = 26; d <= 30; d++) await addManual(emp2().id, `2026-10-${d}T08:00:00Z`, `2026-10-${d}T17:00:00Z`);
  });

  it('only admins change limits, and changes are audited for the person', async () => {
    expect((await manager().client.put('/v1/admin/work-limits', { organization: { daily_minutes: 480, weekly_minutes: 2400 } })).status).toBe(403);
    const r = await org.admin.put('/v1/admin/work-limits', {
      effective_from: '2026-10-01',
      organization: { daily_minutes: 480, weekly_minutes: 2400 },
    });
    expect(r.status).toBe(200);
    expect(r.body.organization).toEqual({ daily_minutes: 480, weekly_minutes: 2400, effective_from: '2026-10-01' });
    expect((await org.admin.put('/v1/admin/work-limits', { organization: { daily_minutes: 0, weekly_minutes: null } })).status).toBe(400);
  });

  it('computes daily overtime from the organization default', async () => {
    const t = await manager().client.get(`/v1/users/${emp2().id}/timesheets/2026-10-26`);
    expect(t.status).toBe(200);
    expect(t.body.limits).toEqual({ daily_minutes: 480, weekly_minutes: 2400, daily_source: 'organization', weekly_source: 'organization' });
    expect(t.body.totals).toMatchObject({ total_seconds: 45 * H, daily_overtime_seconds: 5 * H, weekly_overtime_seconds: 0, overtime_seconds: 5 * H });
    expect(t.body.totals.days[0]).toMatchObject({ total_seconds: 9 * H, overtime_seconds: H });
  });

  it('applies a per-user override and adds weekly overtime without double counting', async () => {
    const r = await org.admin.put('/v1/admin/work-limits', {
      effective_from: '2026-10-01',
      users: [{ user_id: emp2().id, limits: { daily_minutes: null, weekly_minutes: 35 * 60 } }],
    });
    expect(r.body.users).toEqual([
      expect.objectContaining({
        user_id: emp2().id,
        daily_minutes: null,
        weekly_minutes: 2100,
        effective: { daily_minutes: 480, weekly_minutes: 2100, daily_source: 'organization', weekly_source: 'user' },
      }),
    ]);
    const t = await emp2().client.get('/v1/me/timesheets/2026-10-26');
    // 45h − 5h daily overtime = 40h regular, 5h over the 35h weekly limit.
    expect(t.body.totals).toMatchObject({ daily_overtime_seconds: 5 * H, weekly_overtime_seconds: 5 * H, overtime_seconds: 10 * H });

    const log = await emp2().client.get('/v1/me/access-log');
    expect(log.body.items.map((e: { action: string }) => e.action)).toContain('work_limits.update');
  });

  it('shows overtime to the team manager, sorted by name, and to nobody else', async () => {
    const r = await manager().client.get(`/v1/teams/${org.teamId}/overtime?from=2026-10-26&to=2026-11-01`);
    expect(r.status).toBe(200);
    expect(r.body.weeks).toEqual(['2026-10-26']);
    expect(r.body.members.map((m: { display_name: string }) => m.display_name)).toEqual(['ts emp', 'ts emp2', 'ts manager']);
    const row = r.body.members.find((m: { user_id: string }) => m.user_id === emp2().id);
    expect(row).toMatchObject({ total_seconds: 45 * H, overtime_seconds: 10 * H, weeks: [{ status: 'draft', overtime_seconds: 10 * H }] });
    expect((await emp().client.get(`/v1/teams/${org.teamId}/overtime?from=2026-10-26&to=2026-11-01`)).status).toBe(403);
  });

  it('gives the employee their limits and what is left today and this week', async () => {
    const r = await emp2().client.get('/v1/me/work-limits');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      timezone: 'UTC',
      limits: { daily_minutes: 480, weekly_minutes: 2100 },
      today: { date: '2026-11-03', worked_seconds: 0, remaining_seconds: 8 * H, overtime_seconds: 0 },
      week: { period_start: '2026-11-02', worked_seconds: 0, remaining_seconds: 35 * H },
    });
  });

  it('removing an override falls back to the organization default', async () => {
    await org.admin.put('/v1/admin/work-limits', { effective_from: '2026-10-01', users: [{ user_id: emp2().id, limits: null }] });
    const r = await org.admin.get('/v1/admin/work-limits');
    expect(r.body.users).toEqual([]);
    const t = await emp2().client.get('/v1/me/timesheets/2026-10-26');
    expect(t.body.totals.overtime_seconds).toBe(5 * H);
  });
});

describe('isolation and plans', () => {
  it('keeps timesheets inside their organization', async () => {
    const other = await makeOrg(env, 'ts-other');
    expect((await other.admin.get(`/v1/users/${emp().id}/timesheets/2026-10-26`)).status).toBe(404);
    const sheet = await env.deps.pool.query(`SELECT id FROM timesheets WHERE organization_id = $1 LIMIT 1`, [org.id]);
    expect((await other.admin.post(`/v1/timesheets/${sheet.rows[0].id}/approve`)).status).toBe(404);
    expect((await other.admin.get('/v1/timesheets/pending')).body.items).toEqual([]);
    for (const table of ['timesheets', 'timesheet_events', 'work_limits']) {
      const r = await withScope(other.id, () => env.deps.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [org.id]));
      expect(r.rows[0].n).toBe(0);
    }
    await expect(
      withScope(other.id, () =>
        env.deps.pool.query(`INSERT INTO work_limits (organization_id, daily_minutes, effective_from) VALUES ($1, 60, '2026-10-01')`, [org.id]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('requires a plan with timesheets', async () => {
    const free = await makeOrg(env, 'ts-free', 'free');
    for (const r of [
      await free.users.emp!.client.get('/v1/me/timesheets/2026-10-26'),
      await free.users.emp!.client.post('/v1/me/timesheets/2026-10-26/submit'),
      await free.users.emp!.client.get('/v1/me/work-limits'),
      await free.admin.get('/v1/admin/work-limits'),
    ]) {
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe('plan_upgrade_required');
    }
    const standard = await makeOrg(env, 'ts-std', 'standard');
    expect((await standard.users.emp!.client.get('/v1/me/timesheets/2026-10-26')).status).toBe(200);
  });
});
