import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { remindExpiringTokens } from '../src/modules/api-tokens/service';
import { API_SURFACE } from '../src/modules/api-tokens/surface';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Stage 4 F5: API tokens. */

let env: TestEnv;
let org: Org;

async function api(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const res = await env.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: body as object | undefined });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const db = (sql: string, args: unknown[]) => withScope(SYSTEM_SCOPE, () => env.deps.pool.query(sql, args)).then((r) => r.rows);
const newToken = (client: Org['admin'], body: Record<string, unknown>) => client.post('/v1/api-tokens', { expires_in_days: 30, ...body });

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'tok');
});

describe('the API surface', () => {
  it('every documented endpoint exists, and the reference lists them', async () => {
    for (const e of API_SURFACE) expect(env.app.hasRoute({ method: e.method, url: e.path }), `${e.method} ${e.path}`).toBe(true);
    const html = await env.app.inject({ method: 'GET', url: '/v1/docs' });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('/v1/admin/users');
    const spec = JSON.parse((await env.app.inject({ method: 'GET', url: '/v1/docs/openapi.json' })).body);
    expect(spec.paths['/v1/users/{id}/sessions'].get['x-rd-scopes']).toEqual(['read']);
    expect(spec.paths['/v1/admin/rates/pay'].get['x-rd-scopes']).toEqual(['read', 'payroll']);
  });
});

describe('organization tokens', () => {
  let read: string;
  let write: string;

  it('an admin creates them; the secret is shown once', async () => {
    const r = await newToken(org.admin, { name: 'Looker', kind: 'organization', scopes: ['read'] });
    expect(r.status).toBe(201);
    read = r.body.token;
    expect(read).toMatch(/^rdt_org_/);
    expect(r.body).toMatchObject({ name: 'Looker', kind: 'organization', scopes: ['read'], owner_name: 'tok Admin', expired: false });
    const list = await org.admin.get('/v1/api-tokens');
    expect(JSON.stringify(list.body)).not.toContain(read);
    write = (await newToken(org.admin, { name: 'HRIS import', kind: 'organization', scopes: ['read', 'write'] })).body.token;
    expect((await newToken(org.admin, { name: 'Long', kind: 'organization', scopes: ['read'], expires_in_days: 400 })).status).toBe(400);
    expect((await newToken(org.users.manager!.client, { name: 'Mine', kind: 'organization', scopes: ['read'] })).status).toBe(403);
  });

  it('read tokens read; writing needs the write scope; no cookie or CSRF header involved', async () => {
    expect((await api(read, 'GET', '/v1/admin/users')).body.items.length).toBeGreaterThan(3);
    const denied = await api(read, 'POST', '/v1/admin/users', { email: 'x@tok.test', display_name: 'X' });
    expect(denied).toMatchObject({ status: 403, body: { error: { code: 'insufficient_scope' } } });
    const made = await api(write, 'POST', '/v1/admin/users', { email: 'new.hire@tok.test', display_name: 'New Hire' });
    expect(made.status).toBe(201);
    const audit = (await org.admin.get(`/v1/audit-events?subject_id=${made.body.user.id}`)).body.items;
    const create = audit.find((e: { action: string }) => e.action === 'user.create');
    expect(create).toMatchObject({ actor_type: 'api_token', actor_name: 'API token · HRIS import' });
    expect(create.metadata.on_behalf_of).toBe(org.adminId);
  });

  it('only reaches the documented endpoints: no tokens, sign-in settings or screenshot images', async () => {
    for (const [method, url] of [
      ['GET', '/v1/admin/sso'],
      ['GET', '/v1/api-tokens'],
      ['POST', '/v1/me/password'],
      ['GET', '/v1/screenshots/00000000-0000-0000-0000-000000000000/view-url'],
      ['GET', '/v1/admin/support-grants'],
    ] as const) {
      expect((await api(write, method, url, method === 'POST' ? {} : undefined)).body.error.code, url).toBe('not_in_api');
    }
    expect((await api('rdt_org_' + 'x'.repeat(40), 'GET', '/v1/admin/users')).body.error.code).toBe('invalid_token');
  });

  it('pay rates need the payroll scope', async () => {
    expect((await api(read, 'GET', '/v1/admin/rates/pay')).body.error.code).toBe('insufficient_scope');
    const payroll = (await newToken(org.admin, { name: 'Payroll sync', kind: 'organization', scopes: ['read', 'payroll'] })).body.token;
    expect((await api(payroll, 'GET', '/v1/admin/rates/pay')).status).toBe(200);
  });

  it('every call is audited under the token, refused ones included', async () => {
    const rows = await db(
      `SELECT result, metadata->>'route' AS route FROM audit_logs a JOIN api_tokens t ON t.id = a.actor_id
       WHERE a.action = 'api.request' AND t.name = 'Looker' ORDER BY a.id`,
      [],
    );
    expect(rows.map((r) => r.result)).toEqual(['success', 'denied', 'denied']);
    expect(rows[0].route).toBe('/v1/admin/users');
  });
});

describe('personal tokens', () => {
  it("are read-only and see only their creator's own data", async () => {
    const emp = org.users.emp!.client;
    expect((await newToken(emp, { name: 'Mine', kind: 'personal', scopes: ['read', 'write'] })).status).toBe(400);
    expect((await newToken(emp, { name: 'Mine', kind: 'personal', expires_in_days: 120 })).status).toBe(400);
    const r = await newToken(emp, { name: 'My timesheet export', kind: 'personal' });
    expect(r.body).toMatchObject({ kind: 'personal', scopes: ['read'] });
    expect(r.body.token).toMatch(/^rdt_pat_/);
    const t = r.body.token;
    expect((await api(t, 'GET', '/v1/me/sessions?from=2026-10-01T00:00:00Z&to=2026-10-27T00:00:00Z')).status).toBe(200);
    expect((await api(t, 'GET', '/v1/teams')).body.error.code).toBe('insufficient_scope');
    expect((await api(t, 'GET', `/v1/users/${org.users.emp2!.id}/sessions`)).body.error.code).toBe('insufficient_scope');
    // Their list has their token only; admins see everyone's.
    expect((await emp.get('/v1/api-tokens')).body.items.map((x: { name: string }) => x.name)).toEqual(['My timesheet export']);
    expect((await org.admin.get('/v1/api-tokens')).body.items.map((x: { name: string }) => x.name)).toContain('My timesheet export');
  });

  it("a manager's token reading someone's time shows in that person's access log; their own token reading their own doesn't", async () => {
    const m = (await newToken(org.users.manager!.client, { name: 'Manager BI', kind: 'personal' })).body.token;
    expect((await api(m, 'GET', `/v1/users/${org.users.emp!.id}/sessions?from=2026-10-01T00:00:00Z&to=2026-10-27T00:00:00Z`)).body.error.code).toBe('insufficient_scope');
    // A token sees what its creator could: an admin sees someone's time only for a team they manage.
    const o = (await newToken(org.admin, { name: 'Team BI', kind: 'organization', scopes: ['read'] })).body.token;
    const url = `/v1/users/${org.users.emp!.id}/sessions?from=2026-10-01T00:00:00Z&to=2026-10-27T00:00:00Z`;
    expect((await api(o, 'GET', url)).status).toBe(403);
    await org.admin.post(`/v1/admin/teams/${org.teamId}/members`, { user_id: org.adminId, role: 'manager' });
    expect((await api(o, 'GET', url)).status).toBe(200);
    const log = (await org.users.emp!.client.get('/v1/me/access-log')).body.items;
    expect(log.map((e: { actor_name: string }) => e.actor_name)).toContain('API token · Team BI');
    expect(log.map((e: { actor_name: string }) => e.actor_name)).not.toContain('API token · My timesheet export');
  });
});

describe('when a token stops working', () => {
  it('revoked by an admin, or its owner; others cannot', async () => {
    const r = await newToken(org.users.emp!.client, { name: 'Short-lived', kind: 'personal' });
    expect((await org.users.emp2!.client.post(`/v1/api-tokens/${r.body.id}/revoke`)).status).toBe(403);
    expect((await org.admin.post(`/v1/api-tokens/${r.body.id}/revoke`)).status).toBe(200);
    expect((await api(r.body.token, 'GET', '/v1/me')).body.error.code).toBe('invalid_token');
  });

  it('when its creator is deactivated', async () => {
    const r = await newToken(org.users.emp2!.client, { name: 'Leaver', kind: 'personal' });
    await org.admin.post(`/v1/admin/users/${org.users.emp2!.id}/deactivate`);
    expect((await api(r.body.token, 'GET', '/v1/me')).body.error.code).toBe('invalid_token');
  });

  it('when the plan no longer includes the API', async () => {
    const r = await newToken(org.admin, { name: 'Plan check', kind: 'organization', scopes: ['read'] });
    await db(`UPDATE subscriptions SET plan = 'standard', status = 'active' WHERE organization_id = $1`, [org.id]);
    expect((await api(r.body.token, 'GET', '/v1/me')).body.error.code).toBe('plan_upgrade_required');
    expect((await newToken(org.admin, { name: 'Nope', kind: 'organization', scopes: ['read'] })).status).toBe(402);
    await db(`UPDATE subscriptions SET plan = 'pro' WHERE organization_id = $1`, [org.id]);
  });

  it('a week before it expires, the owner is told once; then it stops', async () => {
    const r = await newToken(org.admin, { name: 'Expiring', kind: 'organization', scopes: ['read'], expires_in_days: 5 });
    expect(await remindExpiringTokens(env.deps)).toBeGreaterThanOrEqual(1);
    expect(await remindExpiringTokens(env.deps)).toBe(0);
    const notes = await db(`SELECT title, category, link FROM notifications WHERE user_id = $1 AND kind = 'api_token_expiring'`, [org.adminId]);
    expect(notes.find((n) => n.title.includes('Expiring'))).toMatchObject({ category: 'security', link: '/admin/developers' });
    env.clock.advance(6 * 24 * 3600_000);
    expect((await api(r.body.token, 'GET', '/v1/me')).body.error.code).toBe('invalid_token');
  });
});
