import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/lib/crypto';
import { Client, PASSWORD, login, makeOrg, testEnv, type TestEnv } from './helpers';

/** Engine slice 2: invites, password reset, email change, MFA recovery and account settings. */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
});

const linkIn = (text: string, path: string) => new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];
const lastMailTo = (to: string) => env.email.sent.filter((m) => m.to === to).at(-1);

async function post(url: string, payload: object) {
  const res = await env.app.inject({ method: 'POST', url, payload, headers: { 'x-rd-csrf': '1' } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] };
}

describe('invites', () => {
  it('an admin invites; nobody but the person ever sees a password', async () => {
    const org = await makeOrg(env, 'inv1');
    const r = await org.admin.post('/v1/admin/users', { email: 'new@inv1.test', display_name: 'New Person' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ invite_sent: true, user: { invite_pending: true, email: 'new@inv1.test' } });
    expect(JSON.stringify(r.body)).not.toMatch(/password|token/i);

    const mail = lastMailTo('new@inv1.test')!;
    expect(mail.subject).toBe('inv1 Admin invited you to RoundDigital Track');
    const token = linkIn(mail.text, '/invite')!;
    const info = await env.app.inject({ method: 'GET', url: `/v1/invites/${token}` });
    expect(JSON.parse(info.body)).toMatchObject({ email: 'new@inv1.test', display_name: 'New Person', organization_name: 'inv1 Inc' });

    // Can't sign in before accepting.
    expect((await post('/v1/auth/login', { email: 'new@inv1.test', password: 'anything-long-enough' })).status).toBe(401);
    const accepted = await post('/v1/invites/accept', { token, password: 'my-own-password-1', timezone: 'America/Toronto' });
    expect(accepted.status).toBe(200);
    const me = await new Client(env.app, accepted.cookie!).get('/v1/me');
    expect(me.body.user).toMatchObject({ email: 'new@inv1.test', timezone: 'America/Toronto' });
    // The link works once.
    expect((await post('/v1/invites/accept', { token, password: 'my-own-password-2' })).body.error.code).toBe('link_invalid');
    await login(env.app, 'new@inv1.test', 'my-own-password-1');
    const list = await org.admin.get('/v1/admin/users');
    expect(list.body.items.find((u: { email: string }) => u.email === 'new@inv1.test').invite_pending).toBe(false);
  });

  it('resending replaces the earlier link; a joined person can’t be re-invited', async () => {
    const org = await makeOrg(env, 'inv2');
    const r = await org.admin.post('/v1/admin/users', { email: 'p@inv2.test', display_name: 'P' });
    const first = linkIn(lastMailTo('p@inv2.test')!.text, '/invite')!;
    expect((await org.admin.post(`/v1/admin/users/${r.body.user.id}/invite`)).body).toEqual({ invite_sent: true });
    const second = linkIn(lastMailTo('p@inv2.test')!.text, '/invite')!;
    expect(second).not.toBe(first);
    expect((await post('/v1/invites/accept', { token: first, password: 'my-own-password-1' })).status).toBe(400);
    expect((await post('/v1/invites/accept', { token: second, password: 'my-own-password-1' })).status).toBe(200);
    expect((await org.admin.post(`/v1/admin/users/${r.body.user.id}/invite`)).body.error.code).toBe('already_joined');
    // Employees can't invite.
    expect((await org.users.emp!.client.post(`/v1/admin/users/${r.body.user.id}/invite`)).status).toBe(403);
  });

  it('expires after 7 days', async () => {
    const org = await makeOrg(env, 'inv3');
    await org.admin.post('/v1/admin/users', { email: 'late@inv3.test', display_name: 'Late' });
    const token = linkIn(lastMailTo('late@inv3.test')!.text, '/invite')!;
    env.clock.advance(7 * 86_400_000 + 1000);
    expect((await post('/v1/invites/accept', { token, password: 'my-own-password-1' })).body.error.code).toBe('link_invalid');
  });
});

describe('password reset', () => {
  it('answers the same for unknown addresses and sends nothing', async () => {
    const before = env.email.sent.length;
    const r = await post('/v1/auth/password-reset', { email: 'nobody@nowhere.test' });
    expect(r.status).toBe(202);
    expect(env.email.sent.length).toBe(before);
  });

  it('resets with a single-use link, ends every sign-in and tells the person', async () => {
    const org = await makeOrg(env, 'pw1');
    const emp = org.users.emp!.client;
    expect((await post('/v1/auth/password-reset', { email: 'EMP@pw1.test' })).status).toBe(202);
    const token = linkIn(lastMailTo('emp@pw1.test')!.text, '/reset')!;
    expect((await post('/v1/auth/password-reset/confirm', { token, password: 'short' })).status).toBe(400);
    expect((await post('/v1/auth/password-reset/confirm', { token, password: 'a-brand-new-password' })).status).toBe(200);
    expect((await emp.get('/v1/me')).status).toBe(401);
    expect((await post('/v1/auth/password-reset/confirm', { token, password: 'another-new-password' })).body.error.code).toBe('link_invalid');
    const fresh = await login(env.app, 'emp@pw1.test', 'a-brand-new-password');
    const notes = (await fresh.get('/v1/me/notifications')).body.items;
    expect(notes[0]).toMatchObject({ kind: 'password_changed', category: 'security' });
  });

  it('someone who never accepted their invite gets the invite again', async () => {
    const org = await makeOrg(env, 'pw2');
    await org.admin.post('/v1/admin/users', { email: 'pending@pw2.test', display_name: 'Pending' });
    await post('/v1/auth/password-reset', { email: 'pending@pw2.test' });
    expect(lastMailTo('pending@pw2.test')!.text).toMatch(/\/invite\?token=/);
  });
});

describe('multi-factor recovery', () => {
  async function enroll(client: Client) {
    const start = await client.post('/v1/auth/mfa/enroll');
    const confirm = await client.post('/v1/auth/mfa/enroll/confirm', { code: totp(start.body.secret_base32, env.clock.t) });
    expect(confirm.status).toBe(200);
    return confirm.body.recovery_codes as string[];
  }

  it('enrolment hands out 10 codes once; each signs in once', async () => {
    const org = await makeOrg(env, 'mfa1');
    const codes = await enroll(org.users.emp!.client);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);

    const again = await login(env.app, 'emp@mfa1.test');
    // Until the second step is done, nothing beyond it opens.
    expect((await again.get('/v1/me/security')).status).not.toBe(200);
    expect((await again.post('/v1/auth/mfa/recovery', { recovery_code: 'aaaa-bbbb' })).status).toBe(401);
    const ok = await again.post('/v1/auth/mfa/recovery', { recovery_code: codes[0]!.toUpperCase() });
    expect(ok.body).toEqual({ ok: true, recovery_codes_left: 9 });
    expect((await again.get('/v1/me/security')).body).toMatchObject({ mfa_enabled: true, recovery_codes_left: 9 });

    const third = await login(env.app, 'emp@mfa1.test');
    expect((await third.post('/v1/auth/mfa/recovery', { recovery_code: codes[0] })).status).toBe(401);
    // New codes replace the old ones.
    const fresh = (await again.post('/v1/auth/mfa/recovery-codes')).body.recovery_codes as string[];
    expect(fresh).toHaveLength(10);
    expect((await third.post('/v1/auth/mfa/recovery', { recovery_code: codes[1] })).status).toBe(401);
    expect((await third.post('/v1/auth/mfa/recovery', { recovery_code: fresh[0] })).status).toBe(200);
  });

  it('an org admin can reset someone else’s MFA, never their own', async () => {
    const org = await makeOrg(env, 'mfa2');
    await enroll(org.users.emp!.client);
    expect((await org.users.manager!.client.post(`/v1/admin/users/${org.users.emp!.id}/mfa/reset`)).status).toBe(403);
    expect((await org.admin.post(`/v1/admin/users/${org.adminId}/mfa/reset`)).status).toBe(400);
    expect((await org.admin.post(`/v1/admin/users/${org.users.emp!.id}/mfa/reset`)).body).toEqual({ ok: true });
    expect((await org.users.emp!.client.get('/v1/me')).status).toBe(401);
    const back = await login(env.app, 'emp@mfa2.test');
    expect((await back.get('/v1/me')).body.user.mfa_enabled).toBe(false);
    expect((await back.get('/v1/me/notifications')).body.items[0]).toMatchObject({ kind: 'mfa_reset', category: 'security' });
    expect((await org.admin.post(`/v1/admin/users/${org.users.emp!.id}/mfa/reset`)).body.error.code).toBe('mfa_not_enrolled');
  });
});

describe('my account', () => {
  it('updates name and time zone', async () => {
    const org = await makeOrg(env, 'acc1');
    const emp = org.users.emp!.client;
    expect((await emp.req('PATCH', '/v1/me', { display_name: 'Emp Renamed', timezone: 'Europe/Paris' })).status).toBe(200);
    expect((await emp.get('/v1/me')).body.user).toMatchObject({ display_name: 'Emp Renamed', timezone: 'Europe/Paris' });
    expect((await emp.req('PATCH', '/v1/me', { timezone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('changes the password with the current one, keeping this sign-in only', async () => {
    const org = await makeOrg(env, 'acc2');
    const here = org.users.emp!.client;
    const elsewhere = await login(env.app, 'emp@acc2.test');
    expect((await here.get('/v1/me/security')).body.other_sessions).toBe(1);
    expect((await here.post('/v1/me/password', { current_password: 'wrong', new_password: 'a-brand-new-password' })).body.error.code).toBe('wrong_password');
    expect((await here.post('/v1/me/password', { current_password: PASSWORD, new_password: 'a-brand-new-password' })).status).toBe(200);
    expect((await here.get('/v1/me')).status).toBe(200);
    expect((await elsewhere.get('/v1/me')).status).toBe(401);
    await login(env.app, 'emp@acc2.test', 'a-brand-new-password');
  });

  it('changes the email only once the new address confirms', async () => {
    const org = await makeOrg(env, 'acc3');
    const emp = org.users.emp!.client;
    expect((await emp.post('/v1/me/email', { new_email: 'emp2@acc3.test', current_password: PASSWORD })).body.error.code).toBe('email_taken');
    expect((await emp.post('/v1/me/email', { new_email: 'fresh@acc3.test', current_password: PASSWORD })).status).toBe(202);
    expect(lastMailTo('emp@acc3.test')!.subject).toBe('Someone asked to change your RoundDigital Track email');
    expect((await emp.get('/v1/me/security')).body.pending_email).toBe('fresh@acc3.test');
    const token = linkIn(lastMailTo('fresh@acc3.test')!.text, '/email-change')!;
    expect((await post('/v1/auth/email-change/confirm', { token })).status).toBe(200);
    expect(lastMailTo('emp@acc3.test')!.subject).toBe('Your RoundDigital Track email was changed');
    await login(env.app, 'fresh@acc3.test');
    expect((await post('/v1/auth/email-change/confirm', { token })).status).toBe(400);
  });

  it('signs out every other browser', async () => {
    const org = await makeOrg(env, 'acc4');
    const other = await login(env.app, 'emp@acc4.test');
    expect((await org.users.emp!.client.post('/v1/me/sessions/sign-out-others')).body).toEqual({ signed_out: 1 });
    expect((await other.get('/v1/me')).status).toBe(401);
  });
});
