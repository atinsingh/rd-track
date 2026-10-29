import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { FakeSamlIdp, makeSigner, type Answer } from './fake-saml-idp';
import { Client, makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** G26: single sign-on through a SAML 2.0 identity provider. */

let env: TestEnv;
let org: Org;
const idp = new FakeSamlIdp();
const attacker = makeSigner('attacker.test');

const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

async function post(url: string, body: unknown, cookie?: string) {
  const res = await env.app.inject({ method: 'POST', url, payload: body as object, headers: cookie ? { cookie, 'x-rd-csrf': '1' } : {} });
  return { status: res.statusCode, body: JSON.parse(res.body), browser: cookieOf(res.headers['set-cookie'], 'rd_sso') };
}

const landing = (body: string) => /content="0;url=([^"]+)"/.exec(body)?.[1]?.replace(/&#38;/g, '&');

/** The provider posts its answer to Track (no cookies: it's cross-site). Returns where the browser goes next. */
async function acs(a: { samlResponse?: string; relayState?: string; acs: string }) {
  const form = new URLSearchParams();
  if (a.samlResponse) form.set('SAMLResponse', a.samlResponse);
  if (a.relayState) form.set('RelayState', a.relayState);
  const res = await env.app.inject({ method: 'POST', url: new URL(a.acs).pathname, payload: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (res.statusCode === 303) return { next: res.headers.location as string };
  expect(res.statusCode).toBe(200);
  return { to: landing(res.body) };
}

/** The browser follows the redirect, now with its cookie. */
async function finish(next: string, browser: string | undefined) {
  const res = await env.app.inject({ method: 'GET', url: next, headers: browser ? { cookie: browser } : {} });
  expect(res.statusCode).toBe(200);
  return { to: landing(res.body), session: cookieOf(res.headers['set-cookie'], 'rd_session') };
}

/** A whole round trip: start, the provider's answer, back in the browser that started it. */
async function roundTrip(start: { body: { redirect_url: string }; browser?: string }, a: Answer) {
  const r = await acs(idp.answer(start.body.redirect_url, a));
  return r.next ? finish(r.next, start.browser) : { to: r.to, session: undefined };
}
const signIn = async (email: string, a: Answer) => roundTrip(await post('/v1/auth/sso/start', { email }), a);

afterAll(async () => {
  await env.close();
});
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'samlco');
});

describe('setting up', () => {
  it("reads the provider's metadata, and shows what to give the provider", async () => {
    const bad = await org.admin.put('/v1/admin/sso/connection', { protocol: 'saml', metadata_xml: '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"/>' });
    expect(bad.body.error.code).toBe('saml_metadata_invalid');
    expect((await org.admin.put('/v1/admin/sso/connection', { protocol: 'saml', metadata_xml: '<!DOCTYPE x [<!ENTITY a "b">]><x/>' })).body.error.code).toBe('saml_metadata_invalid');
    expect((await org.admin.put('/v1/admin/sso/connection', { protocol: 'saml' })).status).toBe(400);

    const ok = await org.admin.put('/v1/admin/sso/connection', { protocol: 'saml', metadata_xml: idp.metadata() });
    expect(ok.status).toBe(200);
    expect(ok.body.connection).toMatchObject({ protocol: 'saml', issuer: null, status: 'draft', saml: { entity_id: idp.entityId, sso_url: idp.ssoUrl } });
    expect(ok.body.connection.saml.certificates).toEqual([{ subject: 'CN=idp.example.test', expires_at: expect.any(String) }]);
    expect(ok.body.saml.acs_url).toBe(`${env.deps.config.webUrl}/v1/auth/sso/saml/${org.id}/acs`);

    const md = await env.app.inject({ method: 'GET', url: new URL(ok.body.saml.metadata_url).pathname });
    expect(md.headers['content-type']).toContain('application/samlmetadata+xml');
    expect(md.body).toContain(`entityID="${ok.body.saml.entity_id}"`);
    expect(md.body).toContain(`Location="${ok.body.saml.acs_url}"`);
  });

  it('turns on only after an admin signed in through it as themselves', async () => {
    const t1 = await post('/v1/admin/sso/test', {}, org.admin.cookie);
    const req = idp.read(t1.body.redirect_url);
    expect(req.url).toBe(idp.ssoUrl);
    expect(req.issuer).toBe(`${env.deps.config.webUrl}/v1/auth/sso/saml/${org.id}`);
    expect((await roundTrip(t1, { nameId: 'emp@samlco.test' })).to).toBe('/admin/sso?test_error=wrong_person');

    const t2 = await post('/v1/admin/sso/test', {}, org.admin.cookie);
    expect(await roundTrip(t2, { nameId: 'admin@samlco.test' })).toEqual({ to: '/admin/sso?test=ok', session: undefined });
    expect((await org.admin.req('PATCH', '/v1/admin/sso', { active: true })).body.connection.status).toBe('active');
  });
});

describe('signing in', () => {
  it('signs people in with a signed answer from their provider', async () => {
    expect((await post('/v1/auth/sso/discover', { email: 'emp@samlco.test' })).body).toEqual({ method: 'sso', password_allowed: true });
    const r = await signIn('emp@samlco.test', {
      nameId: 'u-1001',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      attributes: { 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'EMP@samlco.test' },
    });
    expect(r.to).toBe('/');
    const me = (await new Client(env.app, r.session!).get('/v1/me')).body;
    expect(me.user.email).toBe('emp@samlco.test');
    expect(me.mfa_verified).toBe(true);
    // Bound to the persistent name ID, even once the address changes at the provider.
    const again = await signIn('emp@samlco.test', { nameId: 'u-1001', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', attributes: { mail: 'renamed@samlco.test' } });
    expect((await new Client(env.app, again.session!).get('/v1/me')).body.user.id).toBe(org.users.emp!.id);
  });

  it('a transient name ID is matched by address, never bound', async () => {
    const r = await signIn('emp2@samlco.test', { nameId: '_t8f2', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', attributes: { email: 'emp2@samlco.test' } });
    expect(r.to).toBe('/');
    const u = await withScope(SYSTEM_SCOPE, () => env.deps.pool.query('SELECT sso_subject FROM users WHERE id = $1', [org.users.emp2!.id]));
    expect(u.rows[0].sso_subject).toBe('email:emp2@samlco.test');
  });

  it('refuses forged, unsigned, misaddressed and mismatched answers', async () => {
    const tries: [Answer, string][] = [
      [{ nameId: 'emp@samlco.test', signWith: attacker.key }, 'invalid_token'],
      [{ nameId: 'emp@samlco.test', unsigned: true }, 'invalid_token'],
      [{ nameId: 'emp@samlco.test', audience: 'https://another-app.test' }, 'invalid_token'],
      [{ nameId: 'emp@samlco.test', issuer: 'https://evil.test/saml' }, 'invalid_token'],
      [{ nameId: 'emp@samlco.test', inResponseTo: '_someone-elses-request' }, 'invalid_token'],
      [{ nameId: 'emp@samlco.test', status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }, 'provider'],
    ];
    for (const [a, code] of tries) expect((await signIn('emp@samlco.test', a)).to, JSON.stringify(a)).toBe(`/login?sso_error=${code}`);
    const denied = await withScope(SYSTEM_SCOPE, () =>
      env.deps.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'auth.sso_login' AND result = 'denied'`, [org.id]),
    );
    expect(denied.rows[0].n).toBe(tries.length);
  });

  it('an answer counts once, for the browser that started the sign-in only', async () => {
    const start = await post('/v1/auth/sso/start', { email: 'emp@samlco.test' });
    const answer = idp.answer(start.body.redirect_url, { nameId: 'emp@samlco.test' });
    const r = await acs(answer);
    // Posting the same answer again is refused.
    expect(await acs(answer)).toEqual({ to: '/login?sso_error=expired' });
    expect((await finish(r.next!, 'rd_sso=someone-else')).to).toBe('/login?sso_error=expired');
    expect((await finish(r.next!, undefined)).to).toBe('/login?sso_error=expired');
    const ok = await finish(r.next!, start.browser);
    expect(ok.to).toBe('/');
    expect(ok.session).toBeTruthy();
    expect((await finish(r.next!, start.browser)).to).toBe('/login?sso_error=expired');
    // Another organization's endpoint can't take it.
    const other = await makeOrg(env, 'samlother');
    const start2 = await post('/v1/auth/sso/start', { email: 'emp@samlco.test' });
    const a2 = idp.answer(start2.body.redirect_url, { nameId: 'emp@samlco.test' });
    expect(await acs({ ...a2, acs: a2.acs.replace(org.id, other.id) })).toEqual({ to: '/login?sso_error=expired' });
  });

  it("sign-ins started from the provider's app list are turned away", async () => {
    const start = await post('/v1/auth/sso/start', { email: 'emp@samlco.test' });
    const a = idp.answer(start.body.redirect_url, { nameId: 'emp@samlco.test' });
    expect(await acs({ samlResponse: a.samlResponse, acs: a.acs })).toEqual({ to: '/login?sso_error=start_in_track' });
  });
});

describe('changing the provider', () => {
  it('a rolled certificate keeps it on; another provider goes back to a draft', async () => {
    const next = makeSigner('idp-next.example.test');
    const both = idp.metadata().replace('<md:NameIDFormat>', `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${next.certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>`);
    const r = await org.admin.put('/v1/admin/sso/connection', { protocol: 'saml', metadata_xml: both });
    expect(r.body.connection.status).toBe('active');
    expect(r.body.connection.saml.certificates).toHaveLength(2);
    expect((await signIn('emp@samlco.test', { nameId: 'emp@samlco.test', signWith: next.key })).to).toBe('/');

    const moved = await org.admin.put('/v1/admin/sso/connection', { protocol: 'saml', idp_entity_id: 'https://new-idp.test', sso_url: 'https://new-idp.test/sso', certificate: next.cert });
    expect(moved.body.connection).toMatchObject({ status: 'draft', tested_at: null, saml: { entity_id: 'https://new-idp.test' } });
    expect((await post('/v1/auth/sso/discover', { email: 'emp@samlco.test' })).body).toEqual({ method: 'password' });
  });
});
