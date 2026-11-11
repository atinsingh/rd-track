import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Slice 4b: complete People and Teams pages (G14, G15). */

let env: TestEnv;
let org: Org;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'pt', 'pro', 6);
});

describe('people', () => {
  it('edits name, role and time zone; nobody changes their own role and the last admin stays an admin', async () => {
    const emp = org.users.emp!;
    const r = await org.admin.req('PATCH', `/v1/admin/users/${emp.id}`, { display_name: 'Emp Renamed', org_role: 'finance', timezone: 'Europe/Paris' });
    expect(r.body).toMatchObject({ display_name: 'Emp Renamed', org_role: 'finance', timezone: 'Europe/Paris' });
    expect((await org.admin.req('PATCH', `/v1/admin/users/${emp.id}`, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await org.admin.req('PATCH', `/v1/admin/users/${org.adminId}`, { org_role: 'employee' })).status).toBe(400);
    // A second admin can't demote the only other admin out of existence either.
    await org.admin.req('PATCH', `/v1/admin/users/${org.users.manager!.id}`, { org_role: 'org_admin' });
    const second = await login(env.app, 'manager@pt.test');
    expect((await second.req('PATCH', `/v1/admin/users/${org.adminId}`, { org_role: 'employee' })).status).toBe(200);
    expect((await org.admin.get('/v1/admin/users')).status).toBe(403);
    const last = await second.req('PATCH', `/v1/admin/users/${org.users.emp2!.id}`, { org_role: 'org_admin' });
    expect(last.status).toBe(200);
    // Restore for the rest of the file.
    await second.req('PATCH', `/v1/admin/users/${org.adminId}`, { org_role: 'org_admin' });
    await org.admin.req('PATCH', `/v1/admin/users/${org.users.emp2!.id}`, { org_role: 'employee' });
    await org.admin.req('PATCH', `/v1/admin/users/${org.users.manager!.id}`, { org_role: 'employee' });
    await org.admin.req('PATCH', `/v1/admin/users/${emp.id}`, { org_role: 'employee' });
  });

  it('reactivates a deactivated person, within the seats', async () => {
    const emp2 = org.users.emp2!;
    await org.admin.post(`/v1/admin/users/${emp2.id}/deactivate`);
    await expect(login(env.app, 'emp2@pt.test')).rejects.toThrow();
    const back = await org.admin.post(`/v1/admin/users/${emp2.id}/reactivate`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'active', teams: [] });
    expect((await org.admin.post(`/v1/admin/users/${emp2.id}/reactivate`)).body.error.code).toBe('already_active');
    expect((await login(env.app, 'emp2@pt.test')).cookie).toBeTruthy();
  });

  it('imports people from CSV rows: a dry run checks everything and changes nothing, then each row is its own invite', async () => {
    const rows = [
      { email: 'ana@pt.test', display_name: 'Ana', team: 'Imported' },
      { email: 'ben@pt.test', display_name: 'Ben', org_role: 'finance', tracking_enabled: false, team: 'pt Team' },
      { email: 'ana@pt.test', display_name: 'Ana again' },
      { email: 'not-an-email', display_name: 'Bad' },
      { email: 'emp@pt.test', display_name: 'Exists' },
      { email: 'cy@pt.test', display_name: 'Cy', timezone: 'Nowhere/Land' },
    ];
    // Fill the remaining seats (Ana takes one), then one more tracking person than fits.
    const sub = (await org.admin.get('/v1/billing/subscription')).body;
    const free = sub.seat_ceiling - sub.billable_seats - 1;
    for (let i = 0; i <= free; i++) rows.push({ email: `fill${i}@pt.test`, display_name: `Fill ${i}` });
    const before = env.email.sent.length;
    const dry = await org.admin.post('/v1/admin/users/import', { rows, dry_run: true });
    expect(dry.status).toBe(200);
    const summary = (b: { results: { row: number; ok: boolean; code?: string; team?: string }[] }) =>
      b.results.map((r) => [r.row, r.ok, r.code ?? r.team ?? null]);
    expect(summary(dry.body)).toEqual([
      [1, true, 'created'],
      [2, true, 'joined'],
      [3, false, 'duplicate_row'],
      [4, false, 'validation_failed'],
      [5, false, 'email_taken'],
      [6, false, 'validation_failed'],
      ...Array.from({ length: free }, (_, i) => [7 + i, true, null]),
      [7 + free, false, expect.stringMatching(/seat/)],
    ]);
    expect(env.email.sent.length).toBe(before);
    expect((await org.admin.get('/v1/admin/users')).body.items.some((u: { email: string }) => u.email === 'ana@pt.test')).toBe(false);
    expect((await org.admin.get('/v1/admin/teams')).body.items.some((t: { name: string }) => t.name === 'Imported')).toBe(false);

    const real = await org.admin.post('/v1/admin/users/import', { rows });
    expect(summary(real.body)).toEqual(summary(dry.body));
    expect(real.body).toMatchObject({ dry_run: false, ok: 2 + free, failed: 5 });
    expect(env.email.sent.slice(before).map((m) => m.to)).toEqual(['ana@pt.test', 'ben@pt.test', ...Array.from({ length: free }, (_, i) => `fill${i}@pt.test`)]);
    const users = (await org.admin.get('/v1/admin/users')).body.items as { email: string; org_role: string; invite_pending: boolean; teams: { name: string }[] }[];
    expect(users.find((u) => u.email === 'ben@pt.test')).toMatchObject({ org_role: 'finance', invite_pending: true, teams: [{ name: 'pt Team' }] });
    expect(users.find((u) => u.email === 'ana@pt.test')!.teams).toEqual([expect.objectContaining({ name: 'Imported' })]);
    expect((await org.users.manager!.client.post('/v1/admin/users/import', { rows: [rows[0]] })).status).toBe(403);
  });
});

describe('teams and projects', () => {
  it('renames teams, archives only empty ones, and brings one back by name', async () => {
    const t = await org.admin.post('/v1/admin/teams', { name: 'Ops' });
    expect((await org.admin.req('PATCH', `/v1/admin/teams/${t.body.id}`, { name: 'pt Team' })).body.error.code).toBe('name_taken');
    expect((await org.admin.req('PATCH', `/v1/admin/teams/${t.body.id}`, { name: 'Operations' })).body).toEqual({ id: t.body.id, name: 'Operations' });
    await org.admin.post(`/v1/admin/teams/${t.body.id}/members`, { user_id: org.users.emp!.id, role: 'member' });
    expect((await org.admin.post(`/v1/admin/teams/${t.body.id}/archive`)).body.error.code).toBe('team_not_empty');
    await org.admin.req('DELETE', `/v1/admin/teams/${t.body.id}/members/${org.users.emp!.id}`);
    expect((await org.admin.post(`/v1/admin/teams/${t.body.id}/archive`)).status).toBe(200);
    const names = async () => (await org.admin.get('/v1/admin/teams')).body.items.map((x: { name: string }) => x.name);
    expect(await names()).not.toContain('Operations');
    expect((await org.admin.post(`/v1/admin/teams/${t.body.id}/members`, { user_id: org.users.emp!.id, role: 'member' })).status).toBe(404);
    const back = await org.admin.post('/v1/admin/teams', { name: 'Operations' });
    expect(back.body.id).toBe(t.body.id);
    expect(await names()).toContain('Operations');
  });

  it('renames and archives projects and tasks, and removes project members', async () => {
    const p = org.projectId;
    const task = await org.admin.post(`/v1/admin/projects/${p}/tasks`, { name: 'Design' });
    await org.admin.post(`/v1/admin/projects/${p}/members`, { user_id: org.users.emp!.id, role: 'member' });
    let admin = (await org.admin.get('/v1/admin/projects')).body.items.find((x: { id: string }) => x.id === p);
    expect(admin.members).toEqual([{ user_id: org.users.emp!.id, display_name: expect.any(String), role: 'member' }]);
    // Employees never see who else is on a project.
    expect((await org.users.emp!.client.get('/v1/me/projects')).body.items.every((x: object) => !('members' in x))).toBe(true);

    expect((await org.admin.req('PATCH', `/v1/admin/projects/${p}`, { name: 'Website', client_ref: 'ACME-7' })).body).toMatchObject({ name: 'Website', client_ref: 'ACME-7' });
    expect((await org.admin.req('PATCH', `/v1/admin/projects/${p}/tasks/${task.body.id}`, { name: 'UX design' })).status).toBe(200);
    expect((await org.admin.req('PATCH', `/v1/admin/projects/${p}/tasks/${task.body.id}`, { status: 'archived' })).status).toBe(200);
    admin = (await org.admin.get('/v1/admin/projects')).body.items.find((x: { id: string }) => x.id === p);
    expect(admin.tasks).toEqual([]);

    expect((await org.admin.req('DELETE', `/v1/admin/projects/${p}/members/${org.users.emp!.id}`)).status).toBe(200);
    admin = (await org.admin.get('/v1/admin/projects')).body.items.find((x: { id: string }) => x.id === p);
    expect(admin.members).toEqual([]);

    expect((await org.admin.req('PATCH', `/v1/admin/projects/${p}`, { status: 'archived' })).body.status).toBe('archived');
    expect((await org.users.emp!.client.get('/v1/me/projects')).body.items.map((x: { id: string }) => x.id)).not.toContain(p);
    expect((await org.admin.req('PATCH', `/v1/admin/projects/${p}`, { status: 'active' })).body.status).toBe('active');
    const log = (await org.admin.get('/v1/audit-events?action=project.')).body.items.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(['project.archive', 'project.restore', 'project.member_removed', 'project.update']));
    expect((await org.users.manager!.client.req('PATCH', `/v1/admin/projects/${p}`, { name: 'x' })).status).toBe(403);
  });
});

