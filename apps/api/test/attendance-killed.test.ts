import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bucket, enrollDevice, event, login, makeOrg, minutes, sendBatch, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** A killed agent sends no stop: the server still counts it as a quit when it went silent inside office hours. */

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
  org = await makeOrg(env, 'killco');
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

it('flags a silent end inside office hours, not a quick restart or one after office end', async () => {
  const [s1, s2, s3, s4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  // Killed at 10:00 (last minute 09:59), back at 10:30: a quit with 30 min away.
  await send([started(s1, at(-4 * H)), ...minutes(at(-4 * H), 60).map((m) => bucket(dev, s1, m))]);
  await send([started(s2, at(-150 * M))]);
  // Crash at 12:50, restarted at 12:52: under 5 minutes, not a quit.
  await send(minutes(at(-150 * M), 140).map((m) => bucket(dev, s2, m)));
  await send([started(s3, at(-8 * M))]);
  // Silent from 17:52, after office end, back at 19:00: not a quit.
  env.clock.advance(7 * H);
  await send(minutes(at(-8 * M), 300).map((m) => bucket(dev, s3, m)));
  await send([started(s4, at(6 * H))]);

  const manager = await login(env.app, 'manager@killco.test');
  const res = await manager.get(`/v1/teams/${org.teamId}/report?from=${at(-13 * H)}&to=${at(11 * H)}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = res.body.members.find((m: { user_id: string }) => m.user_id === org.users.emp!.id);
  expect(row).toMatchObject({ quits_during_hours: 1, quit_away_seconds: 30 * 60 });
});
