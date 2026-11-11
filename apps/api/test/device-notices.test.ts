import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, deviceReq, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type TestEnv } from './helpers';

/** Stage 4 F4 / F3: what the tray needs for limit warnings and reminders. */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-10-28T15:00:00Z').getTime(); // a Wednesday
});

const body = <T>(r: { body: T }) => r.body;

describe('device work limits', () => {
  it('is off on plans without work limits', async () => {
    const org = await makeOrg(env, 'lim0', 'free');
    const d = await enrollDevice(env, org, 'emp');
    expect(body(await deviceReq(env, d, 'GET', '/v1/device/work-limits'))).toEqual({ enabled: false });
  });

  it('reports the limits and time worked, leaving out the session the agent counts itself', async () => {
    const org = await makeOrg(env, 'lim1', 'standard');
    const put = await org.admin.put('/v1/admin/work-limits', { effective_from: '2026-10-01', organization: { daily_minutes: 480, weekly_minutes: 2400 } });
    expect(put.status).toBe(200);
    const d = await enrollDevice(env, org, 'emp');
    const earlier = randomUUID();
    const running = randomUUID();
    await sendBatch(env, d, [
      event(d, earlier, 'session.started.v1', {}, '2026-10-27T09:00:00Z'),
      ...minutes('2026-10-27T09:00:00Z', 60).map((m) => bucket(d, earlier, m)),
      event(d, earlier, 'session.stopped.v1', { reason: 'user' }, '2026-10-27T10:00:00Z'),
      event(d, running, 'session.started.v1', {}, '2026-10-28T13:00:00Z'),
      ...minutes('2026-10-28T13:00:00Z', 30).map((m) => bucket(d, running, m)),
    ]);
    await env.drain();

    const all = body(await deviceReq(env, d, 'GET', '/v1/device/work-limits'));
    expect(all).toMatchObject({
      enabled: true,
      daily_minutes: 480,
      weekly_minutes: 2400,
      today: { date: '2026-10-28', worked_seconds: 30 * 60 },
      week: { period_start: '2026-10-26', worked_seconds: 90 * 60 },
    });
    const without = body(await deviceReq(env, d, 'GET', `/v1/device/work-limits?exclude_session_id=${running}`));
    expect(without).toMatchObject({ today: { worked_seconds: 0 }, week: { worked_seconds: 60 * 60 } });
    // Only the device's own user is ever read.
    const other = await enrollDevice(env, org, 'emp2');
    expect(body(await deviceReq(env, other, 'GET', '/v1/device/work-limits')).week.worked_seconds).toBe(0);
  });

  it('needs a device credential', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/v1/device/work-limits' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/v1/device/schedule-today' })).statusCode).toBe(401);
  });
});

describe('device schedule today', () => {
  it('without a schedule the agent uses the person’s own hours', async () => {
    const org = await makeOrg(env, 'sch0');
    const d = await enrollDevice(env, org, 'emp');
    expect(body(await deviceReq(env, d, 'GET', '/v1/device/schedule-today'))).toMatchObject({
      date: '2026-10-28',
      scheduled: false,
      shift: null,
      day_off: null,
    });
  });

  it('gives today’s shift, and nothing on a day off', async () => {
    const org = await makeOrg(env, 'sch1');
    const s = await org.admin.post('/v1/admin/shifts', {
      user_id: org.users.emp!.id,
      timezone: 'UTC',
      weekdays: [1, 2, 3, 4, 5],
      start_time: '09:00',
      end_time: '17:00',
      effective_from: '2026-10-01',
    });
    expect(s.status).toBe(201);
    const d = await enrollDevice(env, org, 'emp');
    expect(body(await deviceReq(env, d, 'GET', '/v1/device/schedule-today'))).toMatchObject({
      scheduled: true,
      shift: { start_at: '2026-10-28T09:00:00.000Z', end_at: '2026-10-28T17:00:00.000Z' },
      day_off: null,
    });
    expect((await org.admin.post('/v1/admin/holidays', { date: '2026-10-28', name: 'Founders Day' })).status).toBe(201);
    expect(body(await deviceReq(env, d, 'GET', '/v1/device/schedule-today'))).toMatchObject({ day_off: 'holiday' });
  });

  it('a weekend with a schedule is not a working day', async () => {
    const org = await makeOrg(env, 'sch2');
    await org.admin.post('/v1/admin/shifts', { user_id: org.users.emp!.id, timezone: 'UTC', weekdays: [1, 2], start_time: '09:00', end_time: '17:00', effective_from: '2026-10-01' });
    const d = await enrollDevice(env, org, 'emp');
    expect(body(await deviceReq(env, d, 'GET', '/v1/device/schedule-today'))).toMatchObject({ scheduled: true, shift: null, day_off: null });
  });
});
