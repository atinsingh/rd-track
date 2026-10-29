import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { purgeDue } from '../src/jobs/runner';
import { unzip } from '../src/lib/zip';
import { certificateText } from '../src/modules/lifecycle/service';
import { encryptSecret, newTotpSecret, totp } from '../src/lib/crypto';
import { createPlatformAdmin } from '../src/modules/platform/routes';
import { bucket, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Slice 5b: an organization's export, closing it, and the certificate of deletion (G17). */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-04T15:00:00Z').getTime();
});

async function track(org: Org) {
  const d = await enrollDevice(env, org, 'emp');
  const sid = randomUUID();
  await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, '2026-11-03T14:00:00Z'), ...minutes('2026-11-03T14:00:00Z', 10).map((m) => bucket(d, sid, m))]);
  await env.drain();
}

describe('organization export', () => {
  it('builds a ZIP of the records admins can see, never activity or secrets', async () => {
    const org = await makeOrg(env, 'lx');
    await track(org);
    expect((await org.users.emp!.client.post('/v1/admin/data-exports')).status).toBe(403);
    const r = await org.admin.post('/v1/admin/data-exports');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'organization', status: 'queued', download_url: null });
    expect((await org.admin.post('/v1/admin/data-exports')).body.error.code).toBe('export_in_progress');
    await env.drain();
    const [ready] = (await org.admin.get('/v1/admin/data-exports')).body.items;
    expect(ready).toMatchObject({ id: r.body.id, status: 'ready' });
    expect(ready.download_url).toMatch(/^memory:\/\/get\//);

    const files = unzip(env.store.objects.get(`data-exports/${org.id}/${r.body.id}.zip`)!.body);
    expect([...files.keys()].slice(0, 2)).toEqual(['README.txt', 'organization.json']);
    expect(files.has('work_sessions.csv') && files.has('audit_logs.csv') && files.has('invoices.csv')).toBe(true);
    for (const f of ['activity_buckets.csv', 'app_usage.csv', 'screenshots.csv', 'auth_tokens.csv']) expect(files.has(f)).toBe(false);
    const users = files.get('users.csv')!.toString();
    expect(users.split('\r\n')[0]).not.toMatch(/password_hash|mfa_secret/);
    expect(users).toContain('emp@lx.test');
    expect(files.get('devices.csv')!.toString().split('\r\n')[0]).not.toContain('credential_hash');
    expect(files.get('work_sessions.csv')!.toString().split('\r\n')).toHaveLength(3); // header, one session, trailing newline
    expect(files.get('README.txt')!.toString()).toContain('Not included: computer activity, app names and screenshots');
    const note = (await org.admin.get('/v1/me/notifications')).body.items.find((n: { kind: string }) => n.kind === 'data_export_ready');
    expect(note).toMatchObject({ link: '/admin/data' });
    // The download is a short-lived link; the file itself expires after a day.
    await withScope(SYSTEM_SCOPE, () => env.deps.pool.query(`UPDATE data_exports SET expires_at = '2026-11-01T00:00:00Z' WHERE id = $1`, [r.body.id]));
    expect((await org.admin.get('/v1/admin/data-exports')).body.items[0]).toMatchObject({ status: 'expired', download_url: null });
  });
});

describe('closing an organization', () => {
  it('needs the exact name, tells everyone, and can be cancelled', async () => {
    const org = await makeOrg(env, 'lc');
    expect((await org.admin.post('/v1/admin/organization/close', { confirm_name: 'lc inc' })).status).toBe(400);
    expect((await org.users.manager!.client.post('/v1/admin/organization/close', { confirm_name: 'lc Inc' })).status).toBe(403);
    const closing = await org.admin.post('/v1/admin/organization/close', { confirm_name: 'lc Inc' });
    expect(closing.body).toMatchObject({ name: 'lc Inc', deletion_scheduled_at: '2026-12-04T15:00:00.000Z', deletion_requested_by_name: 'lc Admin' });
    expect((await org.admin.post('/v1/admin/organization/close', { confirm_name: 'lc Inc' })).body.error.code).toBe('already_closing');
    const kinds = async (c: typeof org.admin) => (await c.get('/v1/me/notifications')).body.items.map((n: { kind: string; category: string }) => `${n.kind}:${n.category}`);
    expect(await kinds(org.admin)).toContain('organization_closing:security');
    expect(await kinds(org.users.emp!.client)).toContain('organization_closing:privacy');
    const cancelled = await org.admin.post('/v1/admin/organization/close/cancel');
    expect(cancelled.body.deletion_scheduled_at).toBeNull();
    expect((await org.admin.post('/v1/admin/organization/close/cancel')).body.error.code).toBe('not_closing');
    const log = (await org.admin.get('/v1/audit-events?action=organization.close')).body.items.map((e: { action: string }) => e.action);
    expect(log).toEqual(['organization.close_cancelled', 'organization.close_scheduled']);
  });

  it('deletes everything on the day, files included, and keeps a certificate outside the tenant', async () => {
    const org = await makeOrg(env, 'ld');
    const other = await makeOrg(env, 'lk');
    await track(org);
    await org.admin.post('/v1/admin/data-exports');
    await env.drain();
    expect([...env.store.objects.keys()].some((k) => k.startsWith(`data-exports/${org.id}/`))).toBe(true);
    await org.admin.post('/v1/admin/organization/close', { confirm_name: 'ld Inc' });

    expect(await purgeDue(env.deps)).toBe(0); // not yet
    env.clock.t += 30 * 86_400_000 + 1000;
    const before = env.email.sent.length;
    expect(await purgeDue(env.deps)).toBe(1);

    const left = await withScope(SYSTEM_SCOPE, async () => {
      const q = (sql: string) => env.deps.pool.query(sql, [org.id]).then((r) => r.rows[0].n as number);
      return {
        org: await q('SELECT count(*)::int AS n FROM organizations WHERE id = $1'),
        users: await q('SELECT count(*)::int AS n FROM users WHERE organization_id = $1'),
        audit: await q('SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1'),
        buckets: await q('SELECT count(*)::int AS n FROM activity_buckets WHERE organization_id = $1'),
      };
    });
    expect(left).toEqual({ org: 0, users: 0, audit: 0, buckets: 0 });
    expect([...env.store.objects.keys()].some((k) => k.includes(org.id))).toBe(false);
    // Everyone else is untouched.
    const kept = await withScope(SYSTEM_SCOPE, () => env.deps.pool.query('SELECT count(*)::int AS n FROM users WHERE organization_id = $1', [other.id]));
    expect(kept.rows[0].n).toBe(4);

    const mail = env.email.sent.slice(before);
    expect(mail.map((m) => m.to)).toEqual(['admin@ld.test']);
    expect(mail[0]!.subject).toBe('Certificate of deletion — ld Inc');

    const secret = newTotpSecret();
    await createPlatformAdmin(env.deps.pool, 'cert@vendor.test', 'Cert', 'operator-password-1', encryptSecret(env.deps.config.appEncryptionKey, secret));
    const login = await env.app.inject({ method: 'POST', url: '/platform/v1/auth/login', payload: { email: 'cert@vendor.test', password: 'operator-password-1' } });
    const raw = login.headers['set-cookie'];
    const h = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, 'x-rd-csrf': '1' };
    await env.app.inject({ method: 'POST', url: '/platform/v1/auth/mfa/verify', headers: h, payload: { code: totp(secret, env.clock.t) } });
    const certs = JSON.parse((await env.app.inject({ method: 'GET', url: '/platform/v1/deletion-certificates', headers: h })).body).items;
    const cert = certs.find((c: { organization_id: string }) => c.organization_id === org.id);
    expect(cert).toMatchObject({ organization_name: 'ld Inc', requested_by_email: 'admin@ld.test', objects_deleted: 1 });
    expect(cert.rows_deleted.users).toBe(4);
    expect(cert.rows_deleted.activity_buckets).toBe(10);
    expect(cert.rows_deleted.audit_logs).toBeGreaterThan(0);
    const { id: _id, digest, ...body } = cert;
    expect(digest).toBe(createHash('sha256').update(certificateText(body)).digest('hex'));
    expect(mail[0]!.text).toContain(digest);
  });
});
