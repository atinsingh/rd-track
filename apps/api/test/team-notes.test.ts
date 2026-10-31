import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Team reports carry data notes as values each screen words in its reader's language. */

let env: TestEnv;
let org: Org;
afterAll(async () => {
  await env.close();
});
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'notesco');
});

describe('team data notes', () => {
  it('count the minutes measured without the OS permission', async () => {
    const dev = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    const start = env.clock.iso(-3 * 3_600_000).slice(0, 16) + ':00.000Z';
    const missing = (b: ReturnType<typeof bucket>) => ({ ...b, payload: { ...b.payload, data_quality: 'permission_missing' } });
    const r = await sendBatch(env, dev, [
      event(dev, sid, 'session.started.v1', { project_id: org.projectId }, start),
      ...minutes(start, 3).map((m) => missing(bucket(dev, sid, m, 0, 0))),
      ...minutes(new Date(Date.parse(start) + 3 * 60_000).toISOString(), 2).map((m) => bucket(dev, sid, m)),
    ]);
    expect(r.body.results.filter((x: { status: string }) => x.status !== 'accepted')).toEqual([]);
    await env.drain();
    const range = `from=${env.clock.iso(-86_400_000)}&to=${env.clock.iso(3_600_000)}`;
    const report = await org.users.manager!.client.get(`/v1/teams/${org.teamId}/report?${range}`);
    expect(report.status).toBe(200);
    const emp = report.body.members.find((m: { user_id: string }) => m.user_id === org.users.emp!.id);
    expect(emp).toMatchObject({ permission_missing_minutes: 3, notes: ['3 min without OS permission'] });
    const others = report.body.members.filter((m: { user_id: string }) => m.user_id !== org.users.emp!.id);
    expect(others.every((m: { permission_missing_minutes: number; notes: string[] }) => m.permission_missing_minutes === 0 && m.notes.length === 0)).toBe(true);
  });
});
