import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { FakeIdp } from './fake-idp';
import { Client, login, makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Slice 6a (G26): single sign-on through the organization's OpenID Connect provider. */

let env: TestEnv;
let org: Org;
let idp: FakeIdp;
const txt = new Map<string, string[][]>();

const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

/** POST that also returns the response cookies (the Client helper drops them). */
async function post(url: string, body: unknown, cookie?: string) {
  const res = await env.app.inject({ method: 'POST', url, payload: body as object, headers: cookie ? { cookie, 'x-rd-csrf': '1' } : {} });
  return { status: res.statusCode, body: JSON.parse(res.body), browser: cookieOf(res.headers['set-cookie'], 'rd_sso') };
}

/** The browser comes back from the provider; returns where the page sends it and any session. */
async function callback(q: Record<string, string>, browser: string | undefined) {
  const res = await env.app.inject({ method: 'GET', url: `/v1/auth/sso/callback?${new URLSearchParams(q)}`, headers: browser ? { cookie: browser } : {} });
  expect(res.statusCode).toBe(200);
  const to = /content="0;url=([^"]+)"/.exec(res.body)?.[1]?.replace(/&#38;/g, '&');
  return { to, session: cookieOf(res.headers['set-cookie'], 'rd_session') };
}

/** Full sign-in for `email`, as the provider's user `claims`. */
async function ssoSignIn(email: string, claims: Record<string, unknown>) {
  const start = await post('/v1/auth/sso/start', { email });
  expect(start.status).toBe(200);
  const a = idp.approve(start.body.redirect_url, claims);
  return callback({ code: a.code, state: a.state }, start.browser);
}

afterAll(async () => {
  await idp.stop();
  await env.close();
});
beforeAll(async () => {
  env = await testEnv();
  env.deps.resolveTxt = async (name) => txt.get(name) ?? [];
  idp = new FakeIdp(env.clock.now);
  await idp.start();
  org = await makeOrg(env, 'acme');
});

describe('setting up', () => {
  it('is a Pro feature', async () => {
    const free = await makeOrg(env, 'freeco', 'free');
    expect((await free.admin.put('/v1/admin/sso/connection', { issuer: idp.issuer, client_id: 'x', client_secret: 'y' })).status).toBe(402);
    expect((await org.users.manager!.client.get('/v1/admin/sso')).status).toBe(403);
  });

  it("reads the provider's configuration before saving, and starts as a draft", async () => {
    const bad = await org.admin.put('/v1/admin/sso/connection', { issuer: 'http://127.0.0.1:1', client_id: idp.clientId, client_secret: idp.clientSecret });
    expect(bad.body.error.code).toBe('issuer_unreachable');
    const ok = await org.admin.put('/v1/admin/sso/connection', { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret });
    expect(ok.status).toBe(200);
    expect(ok.body.connection).toMatchObject({ issuer: idp.issuer, status: 'draft', enforced: false });
    expect(JSON.stringify(ok.body)).not.toContain(idp.clientSecret);
    expect(ok.body.redirect_uri).toMatch(/\/v1\/auth\/sso\/callback$/);
    expect((await org.admin.req('PATCH', '/v1/admin/sso', { active: true })).body.error.code).toBe('sso_untested');
  });

  it('verifies a domain with a DNS TXT record, for one organization only', async () => {
    const d = await org.admin.post('/v1/admin/sso/domains', { domain: 'ACME.test' });
    expect(d.body).toMatchObject({ domain: 'acme.test', verified_at: null, txt_name: '_rd-track.acme.test' });
    expect((await org.admin.post(`/v1/admin/sso/domains/${d.body.id}/verify`)).body.error.code).toBe('txt_not_found');
    txt.set(d.body.txt_name, [[d.body.txt_value.slice(0, 10), d.body.txt_value.slice(10)]]);
    const v = await org.admin.post(`/v1/admin/sso/domains/${d.body.id}/verify`);
    expect(v.body.verified_at).toBeTruthy();
    const other = await makeOrg(env, 'other');
    expect((await other.admin.post('/v1/admin/sso/domains', { domain: 'acme.test' })).body.error.code).toBe('domain_taken');
    expect((await org.admin.post('/v1/admin/sso/domains', { domain: 'https://acme.test/' })).status).toBe(400);
  });

  it('turns on only after an admin signed in through it as themselves', async () => {
    const t1 = await post('/v1/admin/sso/test', {}, org.admin.cookie);
    expect(new URL(t1.body.redirect_url).searchParams.get('login_hint')).toBe('admin@acme.test');
    const wrong = idp.approve(t1.body.redirect_url, { sub: 'emp-sub', email: 'emp@acme.test' });
    expect((await callback({ code: wrong.code, state: wrong.state }, t1.browser)).to).toBe('/admin/sso?test_error=wrong_person');

    const t2 = await post('/v1/admin/sso/test', {}, org.admin.cookie);
    const ok = idp.approve(t2.body.redirect_url, { sub: 'admin-sub', email: 'admin@acme.test', email_verified: true });
    const done = await callback({ code: ok.code, state: ok.state }, t2.browser);
    expect(done).toEqual({ to: '/admin/sso?test=ok', session: undefined });
    const s = (await org.admin.get('/v1/admin/sso')).body;
    expect(s.connection.tested_by_name).toBe('acme Admin');
    expect((await org.admin.req('PATCH', '/v1/admin/sso', { active: true })).body.connection.status).toBe('active');
  });
});

describe('signing in', () => {
  it('sends people of an organization with SSO to its provider, and signs them in', async () => {
    expect((await post('/v1/auth/sso/discover', { email: 'emp@acme.test' })).body).toEqual({ method: 'sso', password_allowed: true });
    expect((await post('/v1/auth/sso/discover', { email: 'emp@other.test' })).body).toEqual({ method: 'password' });
    const r = await ssoSignIn('emp@acme.test', { sub: 'emp-sub', email: 'EMP@acme.test', name: 'Em Ployee' });
    expect(r.to).toBe('/');
    const me = await new Client(env.app, r.session!).get('/v1/me');
    expect(me.body.user.email).toBe('emp@acme.test');
    expect(me.body.mfa_verified).toBe(true);
    // Bound to the provider's subject: a later sign-in matches it even if the address changed there.
    const again = await ssoSignIn('emp@acme.test', { sub: 'emp-sub', email: 'emp.renamed@acme.test' });
    expect((await new Client(env.app, again.session!).get('/v1/me')).body.user.id).toBe(org.users.emp!.id);
  });

  it('refuses a reused or stolen sign-in, a forged token and a token for another sign-in', async () => {
    const start = await post('/v1/auth/sso/start', { email: 'emp@acme.test' });
    const a = idp.approve(start.body.redirect_url, { sub: 'emp-sub', email: 'emp@acme.test' });
    // Another browser can't finish it (or spoil it); the one that started it can, once.
    expect((await callback({ code: a.code, state: a.state }, 'rd_sso=someone-else')).to).toBe('/login?sso_error=expired');
    expect((await callback({ code: a.code, state: a.state }, undefined)).to).toBe('/login?sso_error=expired');
    expect((await callback({ code: a.code, state: a.state }, start.browser)).to).toBe('/');
    expect((await callback({ code: a.code, state: a.state }, start.browser)).to).toBe('/login?sso_error=expired');

    idp.forgeWith = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect((await ssoSignIn('emp@acme.test', { sub: 'emp-sub', email: 'emp@acme.test' })).to).toBe('/login?sso_error=invalid_token');
    idp.forgeWith = null;
    expect((await ssoSignIn('emp@acme.test', { sub: 'emp-sub', email: 'emp@acme.test', nonce: 'replayed' })).to).toBe('/login?sso_error=invalid_token');
    expect((await ssoSignIn('emp@acme.test', { sub: 'emp-sub', email: 'emp@acme.test', aud: 'another-app' })).to).toBe('/login?sso_error=invalid_token');
    const denied = await withScope(SYSTEM_SCOPE, () =>
      env.deps.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'auth.sso_login' AND result = 'denied'`, [org.id]),
    );
    expect(denied.rows[0].n).toBe(3);
    // The provider said no.
    const s = await post('/v1/auth/sso/start', { email: 'emp@acme.test' });
    const st = new URL(s.body.redirect_url).searchParams.get('state')!;
    expect((await callback({ error: 'access_denied', state: st }, s.browser)).to).toBe('/login?sso_error=provider');
  });

  it('when required, people can only use SSO; org admins keep their password', async () => {
    await org.admin.req('PATCH', '/v1/admin/sso', { enforced: true });
    const res = await env.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'emp2@acme.test', password: 'whatever' } });
    expect(JSON.parse(res.body).error.code).toBe('sso_required');
    expect((await post('/v1/auth/sso/discover', { email: 'emp2@acme.test' })).body).toEqual({ method: 'sso', password_allowed: false });
    expect((await post('/v1/auth/sso/discover', { email: 'admin@acme.test' })).body).toEqual({ method: 'sso', password_allowed: true });
    await login(env.app, 'admin@acme.test');
    const before = env.email.sent.length;
    await post('/v1/auth/password-reset', { email: 'emp2@acme.test' });
    expect(env.email.sent.length).toBe(before);
  });

  it('creates accounts on first sign-in for a verified domain only when asked to', async () => {
    expect((await post('/v1/auth/sso/discover', { email: 'new@acme.test' })).body).toEqual({ method: 'password' });
    await org.admin.req('PATCH', '/v1/admin/sso', { jit_provisioning: true });
    expect((await post('/v1/auth/sso/discover', { email: 'new@acme.test' })).body).toEqual({ method: 'sso', password_allowed: false });
    const r = await ssoSignIn('new@acme.test', { sub: 'new-sub', email: 'new@acme.test', given_name: 'Nia', family_name: 'Ewe' });
    const me = (await new Client(env.app, r.session!).get('/v1/me')).body;
    expect(me.user).toMatchObject({ display_name: 'Nia Ewe', org_role: 'employee', tracking_enabled: false });
    // An address outside the verified domains has no account to create.
    const start = await post('/v1/auth/sso/start', { email: 'emp@acme.test' });
    const a = idp.approve(start.body.redirect_url, { sub: 'stranger', email: 'stranger@elsewhere.test' });
    expect((await callback({ code: a.code, state: a.state }, start.browser)).to).toBe('/login?sso_error=no_account');
  });

  it('deactivated people are turned away', async () => {
    // Even with a sign-in already in flight.
    const start = await post('/v1/auth/sso/start', { email: 'emp2@acme.test' });
    await org.admin.post(`/v1/admin/users/${org.users.emp2!.id}/deactivate`);
    const a = idp.approve(start.body.redirect_url, { sub: 'emp2-sub', email: 'emp2@acme.test' });
    expect((await callback({ code: a.code, state: a.state }, start.browser)).to).toBe('/login?sso_error=deactivated');
  });

  it('new connection details go back to a draft, and nobody is locked out meanwhile', async () => {
    const r = await org.admin.put('/v1/admin/sso/connection', { issuer: idp.issuer, client_id: 'rotated', client_secret: 'new' });
    expect(r.body.connection).toMatchObject({ status: 'draft', enforced: false, tested_at: null });
    expect((await post('/v1/auth/sso/discover', { email: 'emp@acme.test' })).body).toEqual({ method: 'password' });
    const audit = await org.admin.get('/v1/audit-events?action=sso.');
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['sso.connection_saved', 'sso.domain_verified', 'sso.tested', 'sso.options_changed']),
    );
  });
});
