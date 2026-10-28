import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, testEnv, type TestEnv } from './helpers';

/** Stage 4: names for the ⌘K palette — only the people and projects you already manage. */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
});

describe('palette directory', () => {
  it('lists the people in teams you manage and your projects, not yourself', async () => {
    const org = await makeOrg(env, 'dir1');
    await org.admin.post(`/v1/admin/projects/${org.projectId}/members`, { user_id: org.users.manager!.id, role: 'manager' });
    const r = await org.users.manager!.client.get('/v1/me/directory');
    expect(r.status).toBe(200);
    expect(r.body.people.map((p: { display_name: string }) => p.display_name)).toEqual(['dir1 emp', 'dir1 emp2']);
    expect(r.body.people[0]).toMatchObject({ user_id: org.users.emp!.id, team_id: org.teamId, team_name: 'dir1 Team' });
    expect(r.body.projects).toEqual([{ id: org.projectId, name: 'dir1 Project' }]);
  });

  it('gives an employee no one, and leaves out deactivated people', async () => {
    const org = await makeOrg(env, 'dir2');
    const emp = await org.users.emp!.client.get('/v1/me/directory');
    expect(emp.body).toEqual({ people: [], projects: [] });
    await org.admin.post(`/v1/admin/users/${org.users.emp2!.id}/deactivate`, {});
    const mgr = await org.users.manager!.client.get('/v1/me/directory');
    expect(mgr.body.people.map((p: { user_id: string }) => p.user_id)).toEqual([org.users.emp!.id]);
  });

  it('never reaches another organisation', async () => {
    const a = await makeOrg(env, 'dir3');
    const b = await makeOrg(env, 'dir4');
    const r = await b.users.manager!.client.get('/v1/me/directory');
    expect(r.body.people.some((p: { user_id: string }) => p.user_id === a.users.emp!.id)).toBe(false);
  });
});
