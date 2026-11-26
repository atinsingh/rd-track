import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, enrollDevice, event, login, makeOrg, minutes, sendBatch, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** The team report counts quits inside office hours, the time away after each, and days under the 8-hour target. */

let env: TestEnv;
let org: Org;
let dev: Device;
const H = 3_600_000;
const M = 60_000;
// The test clock starts Monday 2026-10-26 13:00 UTC.
const at = (offsetMs: number) => new Date(new Date('2026-10-26T13:00:00Z').getTime() + offsetMs).toISOString();

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'attendco');
  dev = await enrollDevice(env, org, 'emp');
  const res = await org.admin.put(`/v1/policies/organization/${org.id}`, {
    settings: { work_hours: { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } },
    change_note: 'Office hours',
    confirm_expansion: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
});

async function send(events: object[]) {
  const r = await sendBatch(env, dev, events);
  expect(r.body.results.filter((x: { status: string }) => x.status !== 'accepted'), JSON.stringify(r.body)).toEqual([]);
  await env.drain();
}
const started = (sid: string, t: string) => event(dev, sid, 'session.started.v1', { project_id: org.projectId }, t);
const stopped = (sid: string, reason: string, t: string) => event(dev, sid, 'session.stopped.v1', { reason }, t);

describe('attendance in the team report', () => {
  it('counts office quits, caps time away at office end, and flags short days', async () => {
    const [s1, s2, s3, s4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // Monday: quit at 12:00, back at 12:20; a project switch at 12:30 is not a quit.
    await send([started(s1, at(-4 * H)), ...minutes(at(-4 * H), 2).map((m) => bucket(dev, s1, m)), stopped(s1, 'quit_during_hours', at(-H))]);
    await send([started(s2, at(-40 * M)), stopped(s2, 'project_switch', at(-30 * M)), started(s3, at(-30 * M))]);
    // Quit again at 16:50; nothing until Tuesday 09:00, so away is capped at 17:00.
    env.clock.advance(4 * H);
    await send([stopped(s3, 'quit_during_hours', at(3 * H + 50 * M))]);
    // Tuesday: a full 8 hours.
    env.clock.advance(24 * H + 30 * M);
    await send([started(s4, at(20 * H)), ...minutes(at(20 * H), 480).map((m) => bucket(dev, s4, m, 60, 0)), stopped(s4, 'user', at(28 * H))]);
    // Wednesday noon: Monday and Tuesday are complete office days.
    env.clock.advance(18 * H + 30 * M);

    // Two days later the manager's web session has expired: sign in again.
    const manager = await login(env.app, 'manager@attendco.test');
    const res = await manager.get(`/v1/teams/${org.teamId}/report?from=${at(-13 * H)}&to=${at(59 * H)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.members.find((m: { user_id: string }) => m.user_id === org.users.emp!.id);
    expect(row).toMatchObject({
      quits_during_hours: 2,
      quit_away_seconds: 20 * 60 + 10 * 60,
      work_days: 2,
      days_under_target: 1,
      target_seconds_per_day: 8 * 3600,
    });
  });
});
