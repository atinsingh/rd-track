import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedOn, weekdayRanges } from '../src/modules/insights/expected';
import type { PersonCalendar } from '../src/modules/scheduling/attendance';
import { bucket, enrollDevice, event, makeOrg, minutes, PASSWORD, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Stage 4 F6: expected hours and utilization. */

const cal = (over: Partial<PersonCalendar> = {}): PersonCalendar => ({ shifts: [], overrides: new Map(), holidays: new Map(), leave: [], sessions: [], ...over });
const noLimits = { daily_minutes: null, weekly_minutes: null };
const nineToFiveThirty = { id: 's', timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:30', effective_from: '2026-01-01', effective_to: null };
const H = 3600;

describe('where expected hours come from', () => {
  it("the organization's standard day on weekdays, when nothing else is set", () => {
    expect(expectedOn(cal(), '2026-10-26', noLimits, 8)).toMatchObject({ expected_seconds: 8 * H, source: 'default' });
    expect(expectedOn(cal(), '2026-10-31', noLimits, 8)).toMatchObject({ expected_seconds: 0, source: 'default' });
  });

  it('work limits before the default: a daily limit, else a fifth of the weekly one', () => {
    expect(expectedOn(cal(), '2026-10-26', { daily_minutes: 450, weekly_minutes: null }, 8).expected_seconds).toBe(7.5 * H);
    expect(expectedOn(cal(), '2026-10-26', { daily_minutes: null, weekly_minutes: 2400 }, 8)).toMatchObject({ expected_seconds: 8 * H, source: 'work_limits' });
  });

  it('a schedule before everything: its shifts only, with overrides', () => {
    const c = cal({ shifts: [nineToFiveThirty] });
    expect(expectedOn(c, '2026-10-26', { daily_minutes: 300, weekly_minutes: null }, 8)).toMatchObject({ expected_seconds: 8.5 * H, source: 'schedule' });
    expect(expectedOn(c, '2026-10-31', noLimits, 8)).toMatchObject({ expected_seconds: 0, source: 'schedule' });
    const changed = cal({ shifts: [nineToFiveThirty], overrides: new Map([['2026-10-27', { date: '2026-10-27', kind: 'change', timezone: 'UTC', start_time: '10:00', end_time: '14:00' }]]) });
    expect(expectedOn(changed, '2026-10-27', noLimits, 8).expected_seconds).toBe(4 * H);
    const cancelled = cal({ shifts: [nineToFiveThirty], overrides: new Map([['2026-10-27', { date: '2026-10-27', kind: 'cancel', timezone: 'UTC', start_time: null, end_time: null }]]) });
    expect(expectedOn(cancelled, '2026-10-27', noLimits, 8).expected_seconds).toBe(0);
  });

  it('holidays expect nothing; time off is taken off', () => {
    const c = cal({
      shifts: [nineToFiveThirty],
      holidays: new Map([['2026-10-28', 'Founders day']]),
      leave: [
        { start_date: '2026-10-26', end_date: '2026-10-26', partial_hours: null },
        { start_date: '2026-10-27', end_date: '2026-10-27', partial_hours: 2 },
      ],
    });
    expect(expectedOn(c, '2026-10-26', noLimits, 8)).toMatchObject({ expected_seconds: 0, leave_seconds: 8.5 * H });
    expect(expectedOn(c, '2026-10-27', noLimits, 8)).toMatchObject({ expected_seconds: 6.5 * H, leave_seconds: 2 * H });
    expect(expectedOn(c, '2026-10-28', noLimits, 8)).toMatchObject({ expected_seconds: 0, holiday: 'Founders day', leave_seconds: 0 });
  });

  it('describes schedules in words', () => {
    expect(weekdayRanges([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(weekdayRanges([5, 1, 3])).toBe('Mon, Wed, Fri');
    expect(weekdayRanges([1, 2])).toBe('Mon, Tue');
    expect(weekdayRanges([2, 3, 4, 6])).toBe('Tue–Thu, Sat');
  });
});

describe('over the API', () => {
  let env: TestEnv;
  let org: Org;
  const week = 'from=2026-10-26T00:00:00Z&to=2026-11-02T00:00:00Z&tz=UTC';

  beforeAll(async () => {
    env = await testEnv();
    env.clock.t = new Date('2026-10-30T12:00:00Z').getTime();
    org = await makeOrg(env, 'exp');
    await org.admin.post('/v1/admin/shifts', { user_id: org.users.emp!.id, weekdays: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00', effective_from: '2026-10-01' });
    await org.admin.post('/v1/admin/holidays', { date: '2026-10-28', name: 'Founders day' });
    const dev = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, dev, [event(dev, sid, 'session.started.v1', {}, '2026-10-26T10:00:00Z'), ...minutes('2026-10-26T10:00:00Z', 60).map((m) => bucket(dev, sid, m))]);
    await env.drain();
  });
  afterAll(() => env.close());

  it('shows each person their tracked time against their own expected hours', async () => {
    const mine = (await org.users.emp!.client.get(`/v1/me/insights?${week}`)).body.expected;
    expect(mine).toMatchObject({ source: 'schedule', schedule: 'Mon–Fri 09:00–17:00', expected_seconds: 4 * 8 * H, tracked_seconds: H, percent: 3 });
    expect(mine.days).toHaveLength(7);
    expect(mine.days[2]).toMatchObject({ date: '2026-10-28', holiday: 'Founders day', expected_seconds: 0 });
    expect(mine.days[0]).toMatchObject({ date: '2026-10-26', expected_seconds: 8 * H, tracked_seconds: H });
    // No schedule or limits: the organization's standard day.
    const other = (await org.users.emp2!.client.get(`/v1/me/insights?${week}`)).body.expected;
    expect(other).toMatchObject({ source: 'default', day_hours: 8, expected_seconds: 4 * 8 * H, percent: 0 });
  });

  it('gives managers counts and averages only, for five or more people', async () => {
    for (const name of ['emp3', 'emp4']) {
      const u = await org.admin.post('/v1/admin/users', { email: `${name}@exp.test`, display_name: name, password: PASSWORD });
      await org.admin.post(`/v1/admin/teams/${org.teamId}/members`, { user_id: u.body.user.id, role: 'member' });
    }
    const team = (await org.users.manager!.client.get(`/v1/teams/${org.teamId}/insights?${week}`)).body;
    const u = team.utilization;
    expect(u.under + u.about + u.over + u.none).toBe(team.member_count);
    expect(u).toMatchObject({ under: 5, about: 0, over: 0, expected_seconds: 4 * 8 * H, tracked_seconds: Math.round(H / 5) });
    expect(JSON.stringify(team)).not.toContain(org.users.emp!.id);
  });
});
