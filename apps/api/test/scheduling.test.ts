import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
import { enqueue } from '../src/jobs/queue';
import { runAccruals } from '../src/modules/scheduling/time-off';
import { login, makeOrg, type Org, type TestEnv, testEnv } from './helpers';

/**
 * Schedules, attendance, holidays and time off (Stage 3, migration 006).
 * Times below are UTC instants; America/Toronto is UTC−4 until 2026-11-01 02:00 (EDT) and
 * UTC−5 afterwards (EST).
 */
let env: TestEnv;
let org: Org;
const TZ = 'America/Toronto';

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'sched');
  for (const k of ['emp', 'emp2', 'manager']) {
    const r = await org.admin.req('PATCH', `/v1/admin/users/${org.users[k]!.id}`, { timezone: TZ });
    expect(r.status).toBe(200);
  }
});
afterAll(() => env.close());

/** Moves the clock; sign-in sessions expire after 12 h of test time, so everyone signs in again. */
async function at(iso: string) {
  env.clock.t = Date.parse(iso);
  org.admin = await login(env.app, 'admin@sched.test');
  for (const k of Object.keys(org.users)) org.users[k]!.client = await login(env.app, `${k}@sched.test`);
}
const id = (k: string) => org.users[k]!.id;
const client = (k: string) => org.users[k]!.client;

async function session(userId: string, start: string, end: string, source: 'agent' | 'manual' = 'manual', orgId = org.id) {
  await env.deps.pool.query(
    `INSERT INTO work_sessions (id, organization_id, user_id, state, source, started_at, ended_at) VALUES ($1, $2, $3, 'stopped', $4, $5, $6)`,
    [randomUUID(), orgId, userId, source, start, end],
  );
}

function byDate(days: { date: string }[]) {
  return Object.fromEntries(days.map((d) => [d.date, d])) as Record<string, any>;
}

async function balance(k: string, policyId: string) {
  const r = await client(k).get('/v1/me/time-off');
  expect(r.status).toBe(200);
  return r.body.balances.find((b: { policy_id: string }) => b.policy_id === policyId);
}

let vacationId: string;

describe('shifts and attendance', () => {
  it('an admin assigns recurring shifts in the person’s time zone; the employee is told', async () => {
    const day = await org.admin.post('/v1/admin/shifts', {
      user_id: id('emp'),
      weekdays: [1, 2, 3, 4, 5],
      start_time: '09:00',
      end_time: '17:00',
      effective_from: '2026-10-01',
    });
    expect(day.status).toBe(201);
    expect(day.body).toMatchObject({ timezone: TZ, overnight: false, weekdays: [1, 2, 3, 4, 5], effective_to: null });

    const night = await org.admin.post('/v1/admin/shifts', {
      user_id: id('emp2'),
      weekdays: [1, 2, 3, 4, 5],
      start_time: '22:00',
      end_time: '06:00',
      effective_from: '2026-10-01',
    });
    expect(night.status).toBe(201);
    expect(night.body.overnight).toBe(true);

    const clash = await org.admin.post('/v1/admin/shifts', {
      user_id: id('emp'),
      weekdays: [5, 6],
      start_time: '10:00',
      end_time: '12:00',
      effective_from: '2026-10-10',
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('shift_overlap');

    expect((await client('emp').post('/v1/admin/shifts', { user_id: id('emp'), weekdays: [6], start_time: '09:00', end_time: '10:00', effective_from: '2026-10-01' })).status).toBe(403);
    const notes = await client('emp').get('/v1/me/notifications');
    expect(notes.body.items.some((n: { kind: string }) => n.kind === 'schedule_change')).toBe(true);
  });

  it('computes on time, late, left early, absent, holiday and unscheduled from sessions of any source', async () => {
    await at('2026-10-26T13:00:00Z');
    await session(id('emp'), '2026-10-19T13:05:00Z', '2026-10-19T21:00:00Z', 'agent'); // Mon 09:05–17:00 EDT
    await session(id('emp'), '2026-10-20T13:30:00Z', '2026-10-20T21:00:00Z'); // Tue 09:30
    await session(id('emp'), '2026-10-21T13:00:00Z', '2026-10-21T19:00:00Z'); // Wed until 15:00
    await session(id('emp'), '2026-10-25T14:00:00Z', '2026-10-25T15:00:00Z'); // Sun, not scheduled
    expect((await org.admin.post('/v1/admin/holidays', { date: '2026-10-23', name: 'Founders Day' })).status).toBe(201);
    // A holiday for another team does not apply.
    const other = await org.admin.post('/v1/admin/teams', { name: 'Elsewhere' });
    expect((await org.admin.post('/v1/admin/holidays', { date: '2026-10-22', name: 'Team offsite', team_id: other.body.id })).status).toBe(201);
    expect((await org.admin.post('/v1/admin/holidays', { date: '2026-10-23', name: 'Again' })).status).toBe(409);

    const r = await client('emp').get('/v1/me/attendance?from=2026-10-19&to=2026-10-25');
    expect(r.status).toBe(200);
    expect(r.body.late_grace_minutes).toBe(10);
    const d = byDate(r.body.days);
    expect(d['2026-10-19']).toMatchObject({ status: 'on_time', late: false, first_start_at: '2026-10-19T13:05:00.000Z', worked_seconds: 7 * 3600 + 55 * 60 });
    expect(d['2026-10-19'].shift).toMatchObject({ start_at: '2026-10-19T13:00:00.000Z', end_at: '2026-10-19T21:00:00.000Z', timezone: TZ });
    expect(d['2026-10-20']).toMatchObject({ status: 'late', late: true, late_minutes: 30 });
    expect(d['2026-10-21']).toMatchObject({ status: 'left_early', left_early: true, early_minutes: 120 });
    expect(d['2026-10-22']).toMatchObject({ status: 'absent', holiday: null });
    expect(d['2026-10-23']).toMatchObject({ status: 'holiday', holiday: 'Founders Day' });
    expect(d['2026-10-24']).toMatchObject({ status: 'unscheduled', shift: null });
    expect(d['2026-10-25']).toMatchObject({ status: 'unscheduled' });
    expect(r.body.summary).toMatchObject({ scheduled_days: 5, on_time: 1, late: 1, left_early: 1, absent: 1, holiday: 1 });
  });

  it('a later grace setting changes past attendance (computed on read, nothing cached)', async () => {
    const s = await org.admin.put('/v1/admin/scheduling/settings', { late_grace_minutes: 45 });
    expect(s.status).toBe(200);
    const r = await client('emp').get('/v1/me/attendance?from=2026-10-20&to=2026-10-20');
    expect(r.body.days[0]).toMatchObject({ status: 'on_time', late: false });
    await org.admin.put('/v1/admin/scheduling/settings', { late_grace_minutes: 10 });
  });

  it('an overnight shift belongs to the day it starts and ends the next morning', async () => {
    await session(id('emp2'), '2026-10-20T02:05:00Z', '2026-10-20T10:00:00Z'); // Mon 22:05 → Tue 06:00 EDT
    await session(id('emp2'), '2026-10-21T03:00:00Z', '2026-10-21T10:00:00Z'); // Tue 23:00 → Wed 06:00
    await session(id('emp2'), '2026-10-22T02:00:00Z', '2026-10-22T08:00:00Z'); // Wed 22:00 → Thu 04:00
    const r = await client('emp2').get('/v1/me/attendance?from=2026-10-19&to=2026-10-21');
    const d = byDate(r.body.days);
    expect(d['2026-10-19'].shift).toMatchObject({ overnight: true, start_at: '2026-10-20T02:00:00.000Z', end_at: '2026-10-20T10:00:00.000Z' });
    expect(d['2026-10-19']).toMatchObject({ status: 'on_time', worked_seconds: 7 * 3600 + 55 * 60 });
    expect(d['2026-10-20']).toMatchObject({ status: 'late', late_minutes: 60 });
    expect(d['2026-10-21']).toMatchObject({ status: 'left_early', early_minutes: 120 });
  });

  it('is DST-safe across the America/Toronto change on 1 Nov 2026', async () => {
    await at('2026-11-10T12:00:00Z');
    await session(id('emp'), '2026-10-30T13:00:00Z', '2026-10-30T21:00:00Z'); // Fri 09:00–17:00 EDT
    await session(id('emp'), '2026-11-02T14:00:00Z', '2026-11-02T22:00:00Z'); // Mon 09:00–17:00 EST
    await session(id('emp'), '2026-11-03T14:20:00Z', '2026-11-03T22:00:00Z'); // Tue 09:20 EST
    const r = await client('emp').get('/v1/me/attendance?from=2026-10-26&to=2026-11-03');
    const d = byDate(r.body.days);
    expect(d['2026-10-30'].shift.start_at).toBe('2026-10-30T13:00:00.000Z');
    expect(d['2026-10-30'].status).toBe('on_time');
    expect(d['2026-11-02'].shift.start_at).toBe('2026-11-02T14:00:00.000Z');
    expect(d['2026-11-02'].status).toBe('on_time');
    expect(d['2026-11-03']).toMatchObject({ status: 'late', late_minutes: 20 });

    // A one-off overnight shift on the night the clocks go back is nine hours long.
    const o = await org.admin.post('/v1/admin/shift-overrides', { user_id: id('emp2'), date: '2026-10-31', kind: 'change', start_time: '22:00', end_time: '06:00' });
    expect(o.status).toBe(201);
    expect(o.body.timezone).toBe(TZ);
    await session(id('emp2'), '2026-11-01T02:00:00Z', '2026-11-01T11:00:00Z');
    const n = await client('emp2').get('/v1/me/attendance?from=2026-10-31&to=2026-10-31');
    expect(n.body.days[0].shift).toMatchObject({ source: 'override', start_at: '2026-11-01T02:00:00.000Z', end_at: '2026-11-01T11:00:00.000Z' });
    expect(n.body.days[0]).toMatchObject({ status: 'on_time', worked_seconds: 9 * 3600 });

    const cancel = await org.admin.post('/v1/admin/shift-overrides', { user_id: id('emp'), date: '2026-11-04', kind: 'cancel', note: 'Training day' });
    expect(cancel.status).toBe(201);
    const sched = await client('emp').get('/v1/me/schedule?from=2026-11-02&to=2026-11-04');
    expect(sched.status).toBe(200);
    const sd = byDate(sched.body.days);
    expect(sd['2026-11-02'].shift.start_at).toBe('2026-11-02T14:00:00.000Z');
    expect(sd['2026-11-04']).toMatchObject({ shift: null, cancelled: true });
    expect(sched.body.shifts).toHaveLength(1);
  });

  it('managers see their team’s attendance (sorted by name, audited per member); employees do not', async () => {
    const r = await client('manager').get(`/v1/teams/${org.teamId}/attendance?from=2026-10-19&to=2026-10-25`);
    expect(r.status).toBe(200);
    const names = r.body.members.map((m: { display_name: string }) => m.display_name);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
    const emp = r.body.members.find((m: { user_id: string }) => m.user_id === id('emp'));
    expect(byDate(emp.days)['2026-10-20'].status).toBe('late');
    const log = await client('emp').get('/v1/me/access-log');
    expect(log.body.items.some((e: { action: string }) => e.action === 'attendance.view')).toBe(true);
    expect((await client('emp').get(`/v1/teams/${org.teamId}/attendance?from=2026-10-19&to=2026-10-25`)).status).toBe(403);
    expect((await client('manager').get(`/v1/teams/${org.teamId}/attendance?from=2026-10-01&to=2026-11-30`)).status).toBe(400);
  });

  it('ends a shift that has started instead of deleting its history', async () => {
    await at('2026-11-10T15:00:00Z');
    const list = await org.admin.get(`/v1/admin/shifts?user_id=${id('emp2')}`);
    const shift = list.body.items[0];
    const del = await org.admin.req('DELETE', `/v1/admin/shifts/${shift.id}`);
    expect(del.body).toEqual({ ended: true });
    const after = await org.admin.get(`/v1/admin/shifts?user_id=${id('emp2')}`);
    expect(after.body.items[0].effective_to).toBe('2026-11-09');
    const past = await client('emp2').get('/v1/me/attendance?from=2026-10-19&to=2026-10-19');
    expect(past.body.days[0].status).toBe('on_time');
  });
});

describe('time off', () => {
  it('admins create policies and assign them with an opening balance', async () => {
    const p = await org.admin.post('/v1/admin/time-off/policies', { name: 'Vacation', kind: 'paid' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ accrual: 'none', allow_negative: false, archived: false });
    vacationId = p.body.id;
    for (const [k, hours] of [['emp', 16], ['manager', 40]] as const) {
      const a = await org.admin.post('/v1/admin/time-off/assignments', { policy_id: vacationId, user_id: id(k), start_date: '2026-01-01', opening_balance_hours: hours });
      expect(a.status).toBe(201);
      expect(a.body.balance_hours).toBe(hours);
    }
    expect((await org.admin.post('/v1/admin/time-off/assignments', { policy_id: vacationId, user_id: id('emp'), start_date: '2026-01-01' })).status).toBe(409);
    expect((await client('emp').post('/v1/admin/time-off/policies', { name: 'Mine', kind: 'paid' })).status).toBe(403);
  });

  it('approved leave and partial days suppress absences and deduct the shift’s hours', async () => {
    const full = await client('emp').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-10-15', end_date: '2026-10-15', reason: 'Family' });
    expect(full.status).toBe(201);
    expect(full.body).toMatchObject({ status: 'pending', hours: 8 });
    const part = await client('emp').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-10-16', end_date: '2026-10-16', partial_hours: 4 });
    expect(part.body.hours).toBe(4);
    const managerNotes = await client('manager').get('/v1/me/notifications');
    expect(managerNotes.body.items.some((n: { kind: string }) => n.kind === 'time_off_request')).toBe(true);

    const pending = await client('manager').get('/v1/time-off/pending');
    expect(pending.body.items.map((r: { id: string }) => r.id).sort()).toEqual([full.body.id, part.body.id].sort());
    for (const r of [full.body, part.body]) expect((await client('manager').post(`/v1/time-off/requests/${r.id}/approve`, {})).status).toBe(200);

    expect((await balance('emp', vacationId)).balance_hours).toBe(4);
    const att = await client('emp').get('/v1/me/attendance?from=2026-10-15&to=2026-10-16');
    const d = byDate(att.body.days);
    expect(d['2026-10-15']).toMatchObject({ status: 'on_leave', leave: { hours: 8, partial: false } });
    expect(d['2026-10-16']).toMatchObject({ status: 'on_leave', leave: { hours: 4, partial: true } });

    const cal = await client('manager').get(`/v1/teams/${org.teamId}/calendar?from=2026-10-15&to=2026-10-16`);
    expect(cal.status).toBe(200);
    expect(cal.body.includes).toEqual({ schedules: true, time_off: true });
    const row = cal.body.members.find((m: { user_id: string }) => m.user_id === id('emp'));
    expect(byDate(row.days)['2026-10-15']).toMatchObject({ off: { hours: 8, partial: false }, shift: { start_time: '09:00', end_time: '17:00' } });
    expect(JSON.stringify(cal.body)).not.toContain('Family'); // reasons and policy names stay in Approvals
  });

  it('full days skip weekends and holidays, using the default day for someone without a shift', async () => {
    await at('2026-11-10T15:00:00Z');
    await org.admin.post('/v1/admin/holidays', { date: '2026-11-13', name: 'Long weekend' });
    const est = await client('manager').get('/v1/me/time-off/estimate?start_date=2026-11-11&end_date=2026-11-16');
    expect(est.body.hours).toBe(24); // Wed + Thu + (Fri holiday, Sat, Sun) + Mon
    const r = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-11', end_date: '2026-11-16' });
    expect(r.status).toBe(201);
    expect(r.body.hours).toBe(24);
    expect(await balance('manager', vacationId)).toMatchObject({ balance_hours: 40, pending_hours: 24 });

    // Nobody approves their own request — not even a manager or an admin.
    const own = await client('manager').post(`/v1/time-off/requests/${r.body.id}/approve`, {});
    expect(own.status).toBe(403);
    expect((await client('manager').get('/v1/time-off/pending')).body.items.map((x: { id: string }) => x.id)).not.toContain(r.body.id);
    expect((await client('emp').post(`/v1/time-off/requests/${r.body.id}/approve`, {})).status).toBe(403);

    const ok = await org.admin.post(`/v1/time-off/requests/${r.body.id}/approve`, { note: 'Enjoy' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', review_note: 'Enjoy', reviewer_name: 'sched Admin' });
    expect((await org.admin.post(`/v1/time-off/requests/${r.body.id}/approve`, {})).status).toBe(409);
    const mine = await client('manager').get('/v1/me/time-off');
    expect(mine.body.balances[0]).toMatchObject({ balance_hours: 16, pending_hours: 0 });
    expect(mine.body.ledger.find((e: { request_id: string }) => e.request_id === r.body.id)).toMatchObject({ kind: 'usage', hours: -24 });

    const overlap = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-12', end_date: '2026-11-12' });
    expect(overlap.body.error.code).toBe('overlapping_time_off');
    const tooMuch = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-17', end_date: '2026-11-19' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatchObject({ code: 'insufficient_balance', details: { balance_hours: 16, requested_hours: 24 } });
    const weekend = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-14', end_date: '2026-11-15' });
    expect(weekend.status).toBe(409); // overlaps the approved range
  });

  it('deny keeps the balance; cancelling returns approved hours; started leave cannot be cancelled', async () => {
    const a = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-23', end_date: '2026-11-23' });
    const denied = await org.admin.post(`/v1/time-off/requests/${a.body.id}/deny`, { note: 'Release week' });
    expect(denied.body).toMatchObject({ status: 'denied', review_note: 'Release week' });
    expect((await balance('manager', vacationId)).balance_hours).toBe(16);
    const notes = await client('manager').get('/v1/me/notifications');
    expect(notes.body.items.find((n: { kind: string }) => n.kind === 'time_off_review').body).toContain('Release week');

    const b = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-24', end_date: '2026-11-24' });
    await org.admin.post(`/v1/time-off/requests/${b.body.id}/approve`, {});
    expect((await balance('manager', vacationId)).balance_hours).toBe(8);
    const cancelled = await client('manager').post(`/v1/me/time-off/requests/${b.body.id}/cancel`, {});
    expect(cancelled.body.status).toBe('cancelled');
    expect((await balance('manager', vacationId)).balance_hours).toBe(16);
    expect((await client('manager').post(`/v1/me/time-off/requests/${b.body.id}/cancel`, {})).status).toBe(409);

    const c = await client('manager').post('/v1/me/time-off/requests', { policy_id: vacationId, start_date: '2026-11-25', end_date: '2026-11-25' });
    expect((await client('emp').post(`/v1/me/time-off/requests/${c.body.id}/cancel`, {})).status).toBe(404);
    expect((await client('manager').post(`/v1/me/time-off/requests/${c.body.id}/cancel`, {})).body.status).toBe('cancelled');

    // emp's leave on 15 Oct is in the past.
    const old = (await client('emp').get('/v1/me/time-off')).body.requests.find((r: { start_date: string }) => r.start_date === '2026-10-15');
    const started = await client('emp').post(`/v1/me/time-off/requests/${old.id}/cancel`, {});
    expect(started.body.error.code).toBe('time_off_started');

    const audit = await org.admin.get('/v1/audit-events?action=time_off_request');
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['time_off_request.create', 'time_off_request.approve', 'time_off_request.deny', 'time_off_request.cancel']));
    expect(audit.body.items.every((e: { target_user_id: string | null }) => e.target_user_id)).toBe(true);
  });

  it('accrues once per period, caps at the maximum and expires hours above the carryover', async () => {
    const p = await org.admin.post('/v1/admin/time-off/policies', {
      name: 'Accruing',
      kind: 'paid',
      accrual: 'per_month',
      accrual_hours: 10,
      max_balance_hours: 25,
      carryover_hours: 5,
    });
    expect(p.status).toBe(201);
    await org.admin.post('/v1/admin/time-off/assignments', { policy_id: p.body.id, user_id: id('emp2'), start_date: '2025-06-01' });
    const bal = async () => (await balance('emp2', p.body.id)).balance_hours;

    await runAccruals(env.deps, new Date('2026-10-05T03:00:00Z'));
    await runAccruals(env.deps, new Date('2026-10-20T03:00:00Z'));
    expect(await bal()).toBe(10);
    // Through the worker queue too.
    await at('2026-11-02T03:00:00Z');
    await enqueue(env.deps.pool, 'time_off.accrue', {});
    await enqueue(env.deps.pool, 'time_off.accrue', {});
    await env.drain();
    expect(await bal()).toBe(20);
    await runAccruals(env.deps, new Date('2026-12-01T03:00:00Z'));
    expect(await bal()).toBe(25); // capped at 25
    await runAccruals(env.deps, new Date('2027-01-03T03:00:00Z'));
    await runAccruals(env.deps, new Date('2027-01-04T03:00:00Z'));
    expect(await bal()).toBe(15); // 25 → 5 carried over → +10
    const ledger = (await client('emp2').get('/v1/me/time-off')).body.ledger.filter((e: { policy_id: string }) => e.policy_id === p.body.id);
    expect(ledger.map((e: { kind: string; hours: number }) => `${e.kind}:${e.hours}`).sort()).toEqual(
      ['accrual:10', 'accrual:10', 'accrual:5', 'accrual:10', 'carryover_expiry:-20'].sort(),
    );
    await at('2026-11-10T15:00:00Z');
  });

  it('admins can adjust a balance with a note the employee sees', async () => {
    const r = await org.admin.post('/v1/admin/time-off/adjustments', { policy_id: vacationId, user_id: id('emp'), hours: 6, note: 'Worked the holiday' });
    expect(r.status).toBe(201);
    expect(r.body.balance_hours).toBe(10);
    expect((await org.admin.post('/v1/admin/time-off/adjustments', { policy_id: vacationId, user_id: id('emp2'), hours: 6, note: 'Not on it' })).status).toBe(400);
  });
});

describe('tenant isolation and plan gates', () => {
  it('another organization sees none of these rows, through the API or SQL', async () => {
    const other = await makeOrg(env, 'sched-b');
    expect((await other.admin.get('/v1/admin/shifts')).body.items).toEqual([]);
    expect((await other.admin.get('/v1/admin/holidays')).body.items).toEqual([]);
    expect((await other.admin.get('/v1/admin/time-off/policies')).body.items).toEqual([]);
    const shift = (await org.admin.get('/v1/admin/shifts')).body.items[0];
    expect((await other.admin.req('PATCH', `/v1/admin/shifts/${shift.id}`, { start_time: '08:00' })).status).toBe(404);
    expect((await other.admin.post('/v1/admin/shifts', { user_id: id('emp'), weekdays: [6], start_time: '09:00', end_time: '10:00', effective_from: '2026-12-01' })).status).toBe(404);
    const req = (await client('emp').get('/v1/me/time-off')).body.requests[0];
    expect((await other.admin.post(`/v1/time-off/requests/${req.id}/approve`, {})).status).toBe(404);
    expect((await other.admin.post('/v1/admin/time-off/assignments', { policy_id: vacationId, user_id: other.users.emp!.id, start_date: '2026-01-01' })).status).toBe(404);
    expect((await other.admin.get(`/v1/admin/users/${id('emp')}/attendance?from=2026-10-19&to=2026-10-25`)).status).toBe(404);

    for (const table of ['scheduling_settings', 'shifts', 'shift_overrides', 'holidays', 'time_off_policies', 'time_off_assignments', 'time_off_requests', 'time_off_ledger']) {
      const mine = await withScope(org.id, () => env.deps.pool.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(mine.rows[0].n, table).toBeGreaterThan(0);
      const theirs = await withScope(other.id, () => env.deps.pool.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(theirs.rows[0].n, table).toBe(0);
    }
    await expect(
      withScope(other.id, () => env.deps.pool.query(`INSERT INTO holidays (organization_id, date, name, created_by) VALUES ($1, '2026-12-25', 'x', $2)`, [org.id, org.adminId])),
    ).rejects.toThrow(/row-level security/);
  });

  it('Standard has time off but not schedules; Free has neither (402 plan_upgrade_required)', async () => {
    const std = await makeOrg(env, 'sched-std', 'standard');
    const emp = std.users.emp!.client;
    const att = await emp.get('/v1/me/attendance?from=2026-10-19&to=2026-10-25');
    expect(att.status).toBe(402);
    expect(att.body.error.code).toBe('plan_upgrade_required');
    expect((await emp.get('/v1/me/schedule?from=2026-10-19&to=2026-10-25')).status).toBe(402);
    expect((await std.admin.post('/v1/admin/shifts', { user_id: std.users.emp!.id, weekdays: [1], start_time: '09:00', end_time: '17:00', effective_from: '2026-10-01' })).status).toBe(402);
    expect((await std.users.manager!.client.get(`/v1/teams/${std.teamId}/attendance?from=2026-10-19&to=2026-10-25`)).status).toBe(402);
    expect((await emp.get('/v1/me/time-off')).status).toBe(200);
    expect((await std.admin.post('/v1/admin/holidays', { date: '2026-12-25', name: 'Christmas' })).status).toBe(201);
    const cal = await std.users.manager!.client.get(`/v1/teams/${std.teamId}/calendar?from=2026-12-21&to=2026-12-27`);
    expect(cal.body.includes).toEqual({ schedules: false, time_off: true });
    expect(byDate(cal.body.members[0].days)['2026-12-25'].holiday).toBe('Christmas');

    const free = await makeOrg(env, 'sched-free', 'free');
    expect((await free.users.emp!.client.get('/v1/me/time-off')).status).toBe(402);
    expect((await free.admin.get('/v1/admin/holidays')).status).toBe(402);
    expect((await free.admin.post('/v1/admin/time-off/policies', { name: 'Vacation', kind: 'paid' })).status).toBe(402);
  });

  it('rejects malformed ranges and ids without leaking errors', async () => {
    expect((await client('emp').get('/v1/me/attendance?from=2026-10-25&to=2026-10-19')).status).toBe(400);
    expect((await client('emp').get('/v1/me/attendance?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await client('manager').post('/v1/time-off/requests/not-a-uuid/approve', {})).status).toBe(404);
  });
});
