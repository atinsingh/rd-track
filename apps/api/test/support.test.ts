import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret, newTotpSecret, totp } from '../src/lib/crypto';
import { createPlatformAdmin } from '../src/modules/platform/routes';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Slice 5a: the operator console and support access the tenant approves (G2). */

let env: TestEnv;
let org: Org;
const headers: Record<string, Record<string, string>> = {};

async function operator(email: string) {
  const secret = newTotpSecret();
  await createPlatformAdmin(env.deps.pool, email, email.split('@')[0]!, 'operator-password-1', encryptSecret(env.deps.config.appEncryptionKey, secret));
  const res = await env.app.inject({ method: 'POST', url: '/platform/v1/auth/login', payload: { email, password: 'operator-password-1' } });
  const raw = res.headers['set-cookie'];
  const h = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, 'x-rd-csrf': '1' };
  await env.app.inject({ method: 'POST', url: '/platform/v1/auth/mfa/verify', headers: h, payload: { code: totp(secret, env.clock.t) } });
  headers[email] = h;
}
const op = async (email: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await env.app.inject({ method, url, headers: headers[email]!, ...(payload ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-04T15:00:00Z').getTime();
  org = await makeOrg(env, 'sg');
  await operator('ops@vendor.test');
  await operator('other@vendor.test');
});

describe('operator console', () => {
  it('lists tenants with state and health counts, never activity', async () => {
    const list = await op('ops@vendor.test', 'GET', '/platform/v1/organizations');
    const t = list.body.items.find((x: { id: string }) => x.id === org.id);
    expect(t).toMatchObject({ name: 'sg Inc', plan: 'pro', people: 4, devices: 0, support_active: false, support_pending: false });
    const detail = await op('ops@vendor.test', 'GET', `/platform/v1/organizations/${org.id}`);
    expect(detail.body).toMatchObject({ id: org.id, agent_versions: [], grants: [], devices_stale: 0 });
    expect(JSON.stringify(detail.body)).not.toMatch(/activity|screenshot|tracked_seconds/);
    expect((await op('ops@vendor.test', 'GET', '/platform/v1/me')).body).toMatchObject({ email: 'ops@vendor.test', mfa_verified: true });
  });
});

describe('support grants', () => {
  it('needs a grant the tenant approved, and every read lands in the tenant audit log', async () => {
    const url = `/platform/v1/organizations/${org.id}/support/people`;
    expect((await op('ops@vendor.test', 'GET', url)).body.error.code).toBe('support_grant_required');
    expect((await op('ops@vendor.test', 'GET', `/platform/v1/organizations/${org.id}/support/screenshots`)).status).toBe(400);

    const req = await op('ops@vendor.test', 'POST', `/platform/v1/organizations/${org.id}/support-grants`, { reason: 'Agent on two Macs keeps failing to sync', hours: 2 });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ state: 'pending', requested_hours: 2, operator_name: 'ops', expires_at: null });
    expect((await op('ops@vendor.test', 'POST', `/platform/v1/organizations/${org.id}/support-grants`, { reason: 'Same thing again please', hours: 2 })).body.error.code).toBe(
      'support_request_pending',
    );
    // The org admins are told, with a link to decide.
    const note = (await org.admin.get('/v1/me/notifications')).body.items.find((n: { kind: string }) => n.kind === 'support_request');
    expect(note).toMatchObject({ category: 'security', link: '/admin/support' });
    expect(note.body).toContain('Agent on two Macs');
    expect((await op('ops@vendor.test', 'GET', url)).status).toBe(403);

    // Only org admins decide.
    expect((await org.users.manager!.client.post(`/v1/admin/support-grants/${req.body.id}/approve`)).status).toBe(403);
    const ok = await org.admin.post(`/v1/admin/support-grants/${req.body.id}/approve`);
    expect(ok.body).toMatchObject({ state: 'active', expires_at: '2026-11-04T17:00:00.000Z', decided_by_name: 'sg Admin' });
    expect((await org.admin.post(`/v1/admin/support-grants/${req.body.id}/deny`)).body.error.code).toBe('already_decided');

    const people = await op('ops@vendor.test', 'GET', url);
    expect(people.status).toBe(200);
    expect(people.body.items).toHaveLength(4);
    expect((await op('ops@vendor.test', 'GET', `/platform/v1/organizations/${org.id}/support/devices`)).status).toBe(200);
    // A grant is for the operator who asked, not their colleagues.
    expect((await op('other@vendor.test', 'GET', url)).status).toBe(403);

    const log = (await org.admin.get('/v1/audit-events?action=support.')).body.items as { action: string; actor_name: string; metadata: { section?: string } }[];
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['support.requested', 'support.approved', 'support.viewed']));
    expect(log.find((e) => e.action === 'support.viewed')).toMatchObject({ actor_name: 'RoundDigital support · ops' });
    expect(log.filter((e) => e.action === 'support.viewed').map((e) => e.metadata.section).sort()).toEqual(['devices', 'people']);
    expect((await op('ops@vendor.test', 'GET', '/platform/v1/organizations')).body.items.find((x: { id: string }) => x.id === org.id).support_active).toBe(true);

    // It ends on its own.
    env.clock.t += 2 * 3600_000 + 1000;
    expect((await op('ops@vendor.test', 'GET', url)).status).toBe(403);
    expect((await org.admin.get('/v1/admin/support-grants')).body.items[0].state).toBe('expired');
  });

  it('either side can end access early, and a pending request can be withdrawn', async () => {
    const url = `/platform/v1/organizations/${org.id}/support/teams`;
    const a = await op('ops@vendor.test', 'POST', `/platform/v1/organizations/${org.id}/support-grants`, { reason: 'Checking team managers setup', hours: 8 });
    await org.admin.post(`/v1/admin/support-grants/${a.body.id}/approve`);
    expect((await op('ops@vendor.test', 'GET', url)).status).toBe(200);
    const ended = await org.admin.post(`/v1/admin/support-grants/${a.body.id}/end`);
    expect(ended.body).toMatchObject({ state: 'ended', ended_by: 'tenant' });
    expect((await op('ops@vendor.test', 'GET', url)).status).toBe(403);

    const b = await op('other@vendor.test', 'POST', `/platform/v1/organizations/${org.id}/support-grants`, { reason: 'Billing question about seats', hours: 1 });
    expect((await op('ops@vendor.test', 'POST', `/platform/v1/support-grants/${b.body.id}/end`)).status).toBe(404);
    expect((await op('other@vendor.test', 'POST', `/platform/v1/support-grants/${b.body.id}/end`)).body).toMatchObject({ state: 'ended', ended_by: 'operator' });
    // Declined requests give no access.
    const c = await op('other@vendor.test', 'POST', `/platform/v1/organizations/${org.id}/support-grants`, { reason: 'One more look at devices', hours: 1 });
    expect((await org.admin.post(`/v1/admin/support-grants/${c.body.id}/deny`)).body.state).toBe('denied');
    expect((await op('other@vendor.test', 'GET', url)).status).toBe(403);
    // Another tenant's admin can't see or decide this tenant's requests.
    const other = await makeOrg(env, 'sg2');
    expect((await other.admin.get('/v1/admin/support-grants')).body.items).toEqual([]);
    expect((await other.admin.post(`/v1/admin/support-grants/${c.body.id}/approve`)).status).toBe(404);
  });
});
