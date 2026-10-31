import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** G26 (P2): the organization's logo, and deploying the desktop app with MDM. */

let env: TestEnv;
let org: Org;

const requestCode = (deployment_key: string, email: string) =>
  env.app.inject({ method: 'POST', url: '/v1/devices/enrollment-requests', payload: { deployment_key, email } });

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-10-29T15:00:00Z').getTime();
  org = await makeOrg(env, 'brand');
});

describe('logo', () => {
  it('admins upload a small image; everyone gets a short-lived link to it', async () => {
    expect((await org.users.emp!.client.post('/v1/admin/branding/logo-uploads', { content_type: 'image/png', size_bytes: 2000 })).status).toBe(403);
    expect((await org.admin.post('/v1/admin/branding/logo-uploads', { content_type: 'image/svg+xml', size_bytes: 2000 })).status).toBe(400);
    const up = await org.admin.post('/v1/admin/branding/logo-uploads', { content_type: 'image/png', size_bytes: 2000 });
    expect(up.status).toBe(201);
    const key = `branding/${org.id}/${up.body.upload_id}`;
    expect((await org.admin.put('/v1/admin/branding/logo', { upload_id: up.body.upload_id })).status).toBe(400);
    await env.store.put(key, Buffer.alloc(2000), 'image/png');
    const set = await org.admin.put('/v1/admin/branding/logo', { upload_id: up.body.upload_id });
    expect(set.body.logo_url).toMatch(/^memory:\/\/get\//);
    expect((await org.users.emp!.client.get('/v1/me')).body.organization.logo_url).toContain(encodeURIComponent(up.body.upload_id).slice(0, 8));

    // A new logo replaces the old one in storage too; removing it leaves none.
    const up2 = await org.admin.post('/v1/admin/branding/logo-uploads', { content_type: 'image/webp', size_bytes: 1000 });
    await env.store.put(`branding/${org.id}/${up2.body.upload_id}`, Buffer.alloc(1000), 'image/webp');
    await org.admin.put('/v1/admin/branding/logo', { upload_id: up2.body.upload_id });
    expect(env.store.objects.has(key)).toBe(false);
    const off = await org.admin.req('DELETE', '/v1/admin/branding/logo');
    expect(off.body.logo_url).toBeNull();
    expect((await org.users.emp!.client.get('/v1/me')).body.organization.logo_url).toBeNull();
  });
});

describe('deploying with MDM', () => {
  let key: string;

  it('is part of Pro; the key is shown once', async () => {
    const std = await makeOrg(env, 'brandstd', 'standard');
    expect((await std.admin.post('/v1/admin/deployment-keys', { name: 'Intune' })).status).toBe(402);
    const r = await org.admin.post('/v1/admin/deployment-keys', { name: 'Intune' });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(/^rddk_/);
    expect(r.body.server_url).toBe(env.deps.config.webUrl);
    key = r.body.key;
    const list = (await org.admin.get('/v1/admin/deployment-keys')).body.items;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);
    expect(list[0].hint).toBe(key.slice(-4));
  });

  it('emails a one-time code to the person, and says the same whether or not they exist', async () => {
    expect((await requestCode('rddk_not-a-real-key-at-all', 'emp@brand.test')).statusCode).toBe(401);
    const before = env.email.sent.length;
    expect((await requestCode(key, 'nobody@brand.test')).statusCode).toBe(202);
    expect(env.email.sent.length).toBe(before);
    expect((await requestCode(key, 'EMP@brand.test')).statusCode).toBe(202);
    const mail = env.email.sent.at(-1)!;
    expect(mail.to).toBe('emp@brand.test');
    const code = /^\s{4}(\S+)$/m.exec(mail.text)![1]!;
    // Asking again straight away doesn't send another.
    await requestCode(key, 'emp@brand.test');
    expect(env.email.sent.length).toBe(before + 1);

    const enroll = await env.app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      payload: { enrollment_code: code, device_name: 'Managed Mac', os: 'macos', os_version: '15.6', agent_version: '0.2.0' },
    });
    expect(enroll.statusCode).toBe(201);
    expect(JSON.parse(enroll.body).user_id).toBe(org.users.emp!.id);
    expect((await org.admin.get('/v1/admin/deployment-keys')).body.items[0].last_used_at).not.toBeNull();
    expect((await org.admin.get('/v1/audit-events?action=device.enrollment_code_emailed')).body.items).toHaveLength(1);
  });

  it('a revoked key stops working', async () => {
    const [k] = (await org.admin.get('/v1/admin/deployment-keys')).body.items;
    await org.admin.post(`/v1/admin/deployment-keys/${k.id}/revoke`);
    expect((await requestCode(key, 'emp2@brand.test')).statusCode).toBe(401);
  });
});
