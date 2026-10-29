import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** G27: language and formats for the organization and for each person. */

let env: TestEnv;
let org: Org;

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'lang');
});
afterAll(async () => {
  await env.close();
});

describe('language and formats', () => {
  it('nobody has chosen at first: each browser decides', async () => {
    const me = (await org.users.emp!.client.get('/v1/me')).body;
    expect(me.user.locale).toBeNull();
    expect(me.organization.locale).toBeNull();
  });

  it('an admin sets the organization default; others can only read it', async () => {
    const r = await org.admin.put('/v1/admin/branding/locale', { locale: 'fr-CA' });
    expect(r.status).toBe(200);
    expect(r.body.locale).toBe('fr-CA');
    expect((await org.users.emp!.client.get('/v1/me')).body.organization.locale).toBe('fr-CA');
    expect((await org.users.emp!.client.put('/v1/admin/branding/locale', { locale: 'en-US' })).status).toBe(403);
    expect((await org.admin.put('/v1/admin/branding/locale', { locale: 'de-DE' })).status).toBe(400);
    const audit = await org.admin.get('/v1/audit-events?action=organization.locale_changed');
    expect(audit.body.items[0].metadata).toMatchObject({ locale: 'fr-CA' });
  });

  it('a person picks their own, and can go back to the default', async () => {
    const c = org.users.emp!.client;
    expect((await c.req('PATCH', '/v1/me', { locale: 'en-GB' })).status).toBe(200);
    expect((await c.get('/v1/me')).body.user.locale).toBe('en-GB');
    // Changing something else keeps it.
    await c.req('PATCH', '/v1/me', { display_name: 'Lang Emp' });
    expect((await c.get('/v1/me')).body.user).toMatchObject({ locale: 'en-GB', display_name: 'Lang Emp' });
    await c.req('PATCH', '/v1/me', { locale: null });
    expect((await c.get('/v1/me')).body.user.locale).toBeNull();
    expect((await c.req('PATCH', '/v1/me', { locale: 'xx' })).status).toBe(400);
  });
});
