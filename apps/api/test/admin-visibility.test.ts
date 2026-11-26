import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Org admins see everyone in their own organization, under the same viewer policy as team managers. */

let env: TestEnv;
let org: Org;
let other: Org;
const RANGE = 'from=2026-10-26T00:00:00Z&to=2026-10-28T00:00:00Z';

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'adv');
  other = await makeOrg(env, 'advx');
  const dev = await enrollDevice(env, org, 'emp');
  const sid = randomUUID();
  const r = await sendBatch(env, dev, [
    event(dev, sid, 'session.started.v1', {}, '2026-10-26T12:54:00Z'),
    ...minutes('2026-10-26T12:55:00Z', 3).map((m) => bucket(dev, sid, m, 45, 15)),
  ]);
  expect(r.status).toBe(200);
  env.clock.advance(5 * 60_000);
  await env.drain();
});
afterAll(() => env.close());

describe('org admin viewing', () => {
  const emp = () => org.users.emp!.id;

  it('reads anyone in their org without managing a team, and each view is audited', async () => {
    for (const p of ['sessions', 'activity', 'apps', 'visibility']) {
      expect((await org.admin.get(`/v1/users/${emp()}/${p}?${RANGE}`)).status, p).toBe(200);
    }
    const log = (await org.users.emp!.client.get('/v1/me/access-log')).body.items;
    expect(log.some((e: { action: string; actor_id: string }) => e.action === 'activity.view' && e.actor_id === org.adminId)).toBe(true);
  });

  it('sees every org team and its report, and an everyone report with active and idle time', async () => {
    const teams = (await org.admin.get('/v1/teams')).body.items;
    expect(teams.map((t: { id: string }) => t.id)).toEqual([org.teamId]);
    expect((await org.admin.get(`/v1/teams/${org.teamId}/report?${RANGE}`)).status).toBe(200);
    const all = await org.admin.get(`/v1/org/report?${RANGE}`);
    expect(all.status).toBe(200);
    expect(all.body.members).toHaveLength(4); // admin, manager, emp, emp2
    expect(all.body.members.find((m: { user_id: string }) => m.user_id === emp())).toMatchObject({
      tracked_seconds: 180,
      active_seconds: 135,
      idle_seconds: 45,
    });
    expect((await org.admin.get('/v1/org/report?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z')).status).toBe(400);
    expect(
      (await org.admin.post('/v1/exports', { kind: 'activity_daily', from: '2026-10-26T00:00:00Z', to: '2026-10-28T00:00:00Z', team_id: org.teamId }))
        .status,
    ).toBe(201);
  });

  it('follows the viewer policy like a manager does', async () => {
    const r = await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: { viewers: { manager_can_view_activity: false } },
      change_note: 'No activity detail for viewers',
    });
    expect(r.status).toBe(200);
    expect((await org.admin.get(`/v1/users/${emp()}/activity?${RANGE}`)).status).toBe(403);
    expect((await org.admin.get(`/v1/users/${emp()}/sessions?${RANGE}`)).status).toBe(200);
    const row = (await org.admin.get(`/v1/org/report?${RANGE}`)).body.members.find((m: { user_id: string }) => m.user_id === emp());
    expect(row).toMatchObject({ tracked_seconds: 180, active_seconds: 0, idle_seconds: 0, activity_percent: null });
    await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: { viewers: { manager_can_view_activity: true } },
      change_note: 'Restore',
      confirm_expansion: true,
    });
  });

  it('never reaches another organization', async () => {
    expect((await other.admin.get(`/v1/users/${emp()}/activity?${RANGE}`)).status).toBe(404);
    expect((await other.admin.get(`/v1/users/${emp()}/sessions?${RANGE}`)).status).toBe(404);
    expect((await other.admin.get(`/v1/teams/${org.teamId}/report?${RANGE}`)).status).toBe(404);
    expect((await other.admin.get('/v1/teams')).body.items.map((t: { id: string }) => t.id)).not.toContain(org.teamId);
    const theirs = (await other.admin.get(`/v1/org/report?${RANGE}`)).body.members.map((m: { user_id: string }) => m.user_id);
    expect(theirs).not.toContain(emp());
  });

  it('a plain employee still sees only themself', async () => {
    const emp2 = org.users.emp2!.client;
    expect((await emp2.get(`/v1/users/${emp()}/activity?${RANGE}`)).status).toBe(403);
    expect((await emp2.get(`/v1/users/${emp()}/sessions?${RANGE}`)).status).toBe(403);
    expect((await emp2.get(`/v1/teams/${org.teamId}/report?${RANGE}`)).status).toBe(403);
    expect((await emp2.get(`/v1/org/report?${RANGE}`)).status).toBe(403);
    expect((await emp2.get('/v1/teams')).body.items).toEqual([]);
  });
});
