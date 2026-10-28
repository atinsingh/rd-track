import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret, newTotpSecret, totp } from '../src/lib/crypto';
import { createPlatformAdmin } from '../src/modules/platform/routes';
import { login, makeOrg, testEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await testEnv();
});
afterAll(() => env.close());

async function platformLogin(email: string, password: string) {
  const res = await env.app.inject({ method: 'POST', url: '/platform/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
}

describe('platform operators', () => {
  it('provision tenants on a Pro trial after MFA, without access to tenant data', async () => {
    const secret = newTotpSecret();
    await createPlatformAdmin(env.deps.pool, 'ops@vendor.test', 'Ops', 'operator-password-1', encryptSecret(env.deps.config.appEncryptionKey, secret));
    const cookie = await platformLogin('ops@vendor.test', 'operator-password-1');
    const h = { cookie, 'x-rd-csrf': '1' };

    const before = await env.app.inject({ method: 'GET', url: '/platform/v1/organizations', headers: h });
    expect(before.statusCode).toBe(403);

    const mfa = await env.app.inject({ method: 'POST', url: '/platform/v1/auth/mfa/verify', headers: h, payload: { code: totp(secret, env.clock.t) } });
    expect(mfa.statusCode).toBe(200);

    const created = await env.app.inject({
      method: 'POST',
      url: '/platform/v1/organizations',
      headers: h,
      payload: { name: 'Initech', slug: 'initech', admin_email: 'admin@initech.test', admin_name: 'Bill' },
    });
    expect(created.statusCode).toBe(201);
    const orgId = JSON.parse(created.body).organization_id;
    const sub = (await env.deps.pool.query('SELECT plan, status, trial_ends_at FROM subscriptions WHERE organization_id = $1', [orgId])).rows[0];
    expect(sub).toMatchObject({ plan: 'pro', status: 'trialing' });

    const patched = await env.app.inject({
      method: 'PATCH',
      url: `/platform/v1/organizations/${orgId}/subscription`,
      headers: h,
      payload: { plan: 'standard', seats: 25, status: 'active' },
    });
    expect(patched.statusCode).toBe(200);

    // The operator session is not a tenant session.
    const tenantRoute = await env.app.inject({ method: 'GET', url: '/v1/admin/users', headers: h });
    expect(tenantRoute.statusCode).toBe(401);
    // And tenant users can't reach platform routes.
    const org = await makeOrg(env, 'tenant');
    expect((await org.admin.get('/platform/v1/organizations')).status).toBe(401);
  });

  it('trial end moves an org with more than 2 tracked users into grace, then inactive', async () => {
    const org = await makeOrg(env, 'trial', 'pro', 10);
    await env.deps.pool.query(
      `UPDATE subscriptions SET status = 'trialing', trial_ends_at = $2 WHERE organization_id = $1`,
      [org.id, env.clock.iso(-1000)],
    );
    const s1 = await org.admin.get('/v1/billing/subscription');
    expect(s1.body).toMatchObject({ plan: 'free', status: 'grace', license: 'grace' });
    env.clock.advance(15 * 86_400_000);
    org.admin = await login(env.app, 'admin@trial.test'); // the 12 h session expired meanwhile
    const s2 = await org.admin.get('/v1/billing/subscription');
    expect(s2.body).toMatchObject({ status: 'inactive', license: 'inactive' });
    // Choosing a plan restores service.
    const up = await org.admin.post('/v1/billing/plan', { plan: 'pro', seats: 3 });
    expect(up.body).toMatchObject({ status: 'active', license: 'active', estimated_monthly_cents: 1500 });
  });
});
