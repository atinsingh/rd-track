import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Slice 6b (G26): the organization's directory keeps people and teams in step over SCIM 2.0. */

let env: TestEnv;
let org: Org;
let token: string;

async function scim(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, auth = token) {
  const res = await env.app.inject({
    method,
    url: `/scim/v2${url}`,
    headers: { authorization: `Bearer ${auth}`, ...(body ? { 'content-type': 'application/scim+json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, type: res.headers['content-type'], body: res.body ? JSON.parse(res.body) : null };
}

const db = (sql: string, args: unknown[]) => withScope(SYSTEM_SCOPE, () => env.deps.pool.query(sql, args)).then((r) => r.rows);
const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'dir', 'pro', 10);
});

describe('directory tokens', () => {
  it('an admin creates one, shown once; Pro only', async () => {
    const r = await org.admin.post('/v1/admin/scim-tokens', { label: 'Entra ID' });
    expect(r.status).toBe(201);
    token = r.body.token;
    expect(token).toMatch(/^rdscim_/);
    const settings = (await org.admin.get('/v1/admin/sso')).body;
    expect(settings.scim.tokens).toMatchObject([{ label: 'Entra ID', created_by_name: 'dir Admin' }]);
    expect(JSON.stringify(settings)).not.toContain(token);
    expect(settings.scim.base_url).toMatch(/\/scim\/v2$/);
    const free = await makeOrg(env, 'freedir', 'free');
    expect((await free.admin.post('/v1/admin/scim-tokens', { label: 'x' })).status).toBe(402);
  });

  it('answers without one in SCIM form', async () => {
    const r = await scim('GET', '/Users', undefined, 'rdscim_nope-nope-nope-nope-nope');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
    expect((await scim('GET', '/ServiceProviderConfig')).body.patch.supported).toBe(true);
  });
});

describe('Users', () => {
  it('finds people by userName, the way directories match accounts', async () => {
    const r = await scim('GET', '/Users?filter=userName eq "EMP@dir.test"');
    expect(r.type).toContain('application/scim+json');
    expect(r.body).toMatchObject({ totalResults: 1, Resources: [{ userName: 'emp@dir.test', active: true, displayName: 'dir emp' }] });
    expect((await scim('GET', '/Users?filter=userName eq "nobody@dir.test"')).body).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await scim('GET', '/Users?filter=title co "x"')).body.scimType).toBe('invalidFilter');
    const page = await scim('GET', '/Users?startIndex=2&count=2');
    expect(page.body).toMatchObject({ startIndex: 2, itemsPerPage: 2, totalResults: 4 });
  });

  it('creates people as tracked employees and invites them while SSO is off', async () => {
    const before = env.email.sent.length;
    const r = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'Rae.Smith@dir.test',
      externalId: 'entra-1',
      name: { givenName: 'Rae', familyName: 'Smith' },
      emails: [{ value: 'rae.smith@dir.test', primary: true }],
      active: true,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userName: 'rae.smith@dir.test', displayName: 'Rae Smith', externalId: 'entra-1', active: true });
    const [u] = await db('SELECT org_role, tracking_enabled FROM users WHERE id = $1', [r.body.id]);
    expect(u).toEqual({ org_role: 'employee', tracking_enabled: true });
    expect(env.email.sent.slice(before).map((m) => m.to)).toEqual(['rae.smith@dir.test']);
    expect((await scim('POST', '/Users', { userName: 'rae.smith@dir.test' })).body).toMatchObject({ status: '409', scimType: 'uniqueness' });
    // Addresses are unique across organizations too.
    const other = await makeOrg(env, 'elsewhere');
    expect((await other.admin.post('/v1/admin/users', { email: 'rae.smith@dir.test', display_name: 'X' })).body.error.code).toBe('email_taken');
    const audit = (await org.admin.get(`/v1/audit-events?subject_id=${r.body.id}`)).body.items;
    expect(audit.find((e: { action: string }) => e.action === 'user.create')).toMatchObject({ actor_type: 'directory', actor_name: 'Directory sync' });
  });

  it("follows Entra and Okta PATCH styles: deactivate, reactivate, rename", async () => {
    const id = org.users.emp2!.id;
    let r = await scim('PATCH', `/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'False' }));
    expect(r.body.active).toBe(false);
    const [u] = await db('SELECT status FROM users WHERE id = $1', [id]);
    expect(u.status).toBe('deactivated');
    r = await scim('PATCH', `/Users/${id}`, patch({ op: 'replace', value: { active: true } }));
    expect(r.body.active).toBe(true);
    r = await scim('PATCH', `/Users/${id}`, patch({ op: 'replace', path: 'name.givenName', value: 'Em' }, { op: 'replace', path: 'name.familyName', value: 'Two' }, { op: 'add', path: 'title', value: 'Ignored' }));
    expect(r.body.displayName).toBe('Em Two');
    r = await scim('PATCH', `/Users/${id}`, patch({ op: 'replace', path: 'userName', value: 'em.two@dir.test' }, { op: 'replace', path: 'displayName', value: 'Em T.' }));
    expect(r.body).toMatchObject({ userName: 'em.two@dir.test', displayName: 'Em T.' });
  });

  it('PUT replaces; DELETE deactivates and keeps their records', async () => {
    const id = org.users.emp!.id;
    const r = await scim('PUT', `/Users/${id}`, { userName: 'emp@dir.test', displayName: 'Employee One', active: true });
    expect(r.body.displayName).toBe('Employee One');
    expect((await scim('DELETE', `/Users/${id}`)).status).toBe(204);
    expect((await scim('GET', `/Users/${id}`)).body.active).toBe(false);
    expect((await scim('GET', '/Users/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it("won't deactivate the last admin", async () => {
    const r = await scim('PATCH', `/Users/${org.adminId}`, patch({ op: 'replace', path: 'active', value: false }));
    expect(r.body).toMatchObject({ status: '409', scimType: 'mutability' });
  });
});

describe('Groups', () => {
  it('a group is a team: created, filtered, members added and removed; managers keep their role', async () => {
    const created = await scim('POST', '/Groups', { displayName: 'Support', externalId: 'g-1', members: [{ value: org.users.manager!.id }] });
    expect(created.status).toBe(201);
    expect(created.body.members).toHaveLength(1);
    const gid = created.body.id;
    expect((await scim('GET', '/Groups?filter=displayName eq "Support"&excludedAttributes=members')).body.Resources[0]).not.toHaveProperty('members');
    // An admin makes the manager the team's manager in Track; the directory adding them again keeps it.
    await org.admin.post(`/v1/admin/teams/${gid}/members`, { user_id: org.users.manager!.id, role: 'manager' });
    await scim('PATCH', `/Groups/${gid}`, patch({ op: 'Add', path: 'members', value: [{ value: org.users.manager!.id }, { value: org.users.emp2!.id }] }));
    let m = await db('SELECT user_id, role FROM team_memberships WHERE team_id = $1 AND valid_to IS NULL ORDER BY role', [gid]);
    expect(m).toEqual([
      { user_id: org.users.manager!.id, role: 'manager' },
      { user_id: org.users.emp2!.id, role: 'member' },
    ]);
    await scim('PATCH', `/Groups/${gid}`, patch({ op: 'Remove', path: `members[value eq "${org.users.emp2!.id}"]` }));
    await scim('PATCH', `/Groups/${gid}`, patch({ op: 'Replace', path: 'displayName', value: 'Customer support' }));
    const g = await scim('GET', `/Groups/${gid}`);
    expect(g.body).toMatchObject({ displayName: 'Customer support', externalId: 'g-1', members: [{ value: org.users.manager!.id }] });
    expect((await scim('POST', '/Groups', { displayName: 'Bad', members: [{ value: 'not-a-user' }] })).body.status).toBe('400');
  });

  it("claims an existing team of the same name, and DELETE archives the team", async () => {
    const r = await scim('POST', '/Groups', { displayName: 'dir Team', externalId: 'g-2' });
    expect(r.body.id).toBe(org.teamId);
    expect(r.body.members.length).toBeGreaterThan(0);
    expect((await scim('POST', '/Groups', { displayName: 'dir Team', externalId: 'g-3' })).body.scimType).toBe('uniqueness');
    expect((await scim('DELETE', `/Groups/${org.teamId}`)).status).toBe(204);
    const [t] = await db('SELECT archived_at FROM teams WHERE id = $1', [org.teamId]);
    expect(t.archived_at).toBeTruthy();
    expect((await db('SELECT 1 FROM team_memberships WHERE team_id = $1 AND valid_to IS NULL', [org.teamId])).length).toBe(0);
    expect((await scim('GET', `/Groups/${org.teamId}`)).status).toBe(404);
  });
});

describe('revoking', () => {
  it('stops the token at once', async () => {
    const [t] = (await org.admin.get('/v1/admin/sso')).body.scim.tokens;
    expect(t.last_used_at).toBeTruthy();
    await org.admin.req('DELETE', `/v1/admin/scim-tokens/${t.id}`);
    expect((await scim('GET', '/Users')).status).toBe(401);
  });
});
