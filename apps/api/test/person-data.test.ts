import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { unzip } from '../src/lib/zip';
import { bucket, enrollDevice, event, login, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Slice 5c: a person's own data — download it, and have it erased (G18). */

let env: TestEnv;
let org: Org;
let sessionId: string;
let deviceId: string;

const sys = <T>(fn: () => Promise<T>) => withScope(SYSTEM_SCOPE, fn);
const count = (sql: string, args: unknown[]) => sys(() => env.deps.pool.query(sql, args)).then((r) => r.rows[0].n as number);

async function screenshot(capturedAt: string) {
  const id = randomUUID();
  const key = `screenshots/${org.id}/${id}.webp`;
  env.store.objects.set(key, { body: Buffer.from('RIFF....WEBP'), contentType: 'image/webp' });
  await sys(() =>
    env.deps.pool.query(
      `INSERT INTO screenshots (id, organization_id, session_id, user_id, device_id, object_key, content_type, status, captured_at, policy_revision, intent_expires_at, retention_after)
       VALUES ($1, $2, $3, $4, $5, $6, 'image/webp', 'stored', $7, 1, $7, '2027-01-01T00:00:00Z')`,
      [id, org.id, sessionId, org.users.emp!.id, deviceId, key, capturedAt],
    ),
  );
  return key;
}

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-04T15:00:00Z').getTime();
  org = await makeOrg(env, 'pd');
  const d = await enrollDevice(env, org, 'emp');
  deviceId = d.id;
  sessionId = randomUUID();
  await sendBatch(env, d, [event(d, sessionId, 'session.started.v1', {}, '2026-11-03T14:00:00Z'), ...minutes('2026-11-03T14:00:00Z', 10).map((m) => bucket(d, sessionId, m))]);
  await env.drain();
});

describe('download my data', () => {
  it('holds everything about me, screenshots and who viewed my data included, and nobody else', async () => {
    await screenshot('2026-11-03T14:05:00Z');
    await org.users.manager!.client.get(`/v1/users/${org.users.emp!.id}/sessions?from=2026-11-03T00:00:00Z&to=2026-11-04T00:00:00Z`);
    const r = await org.users.emp!.client.post('/v1/me/data-exports');
    expect(r.status).toBe(201);
    await env.drain();
    const [ready] = (await org.users.emp!.client.get('/v1/me/data-exports')).body.items;
    expect(ready).toMatchObject({ kind: 'person', status: 'ready', subject_user_id: org.users.emp!.id });
    const files = unzip(env.store.objects.get(`data-exports/${org.id}/${r.body.id}.zip`)!.body);
    expect(files.get('activity_buckets.csv')!.toString().trim().split('\r\n')).toHaveLength(11);
    expect([...files.keys()].filter((k) => k.startsWith('screenshots/'))).toHaveLength(1);
    expect(files.get('screenshots.csv')!.toString().split('\r\n')[0]).not.toContain('object_key');
    expect(files.get('audit_logs.csv')!.toString()).toContain(org.users.manager!.id);
    expect(JSON.parse(files.get('profile.json')!.toString())).toMatchObject({ email: 'emp@pd.test', organization: 'pd Inc' });
    // Only mine.
    expect(files.get('work_sessions.csv')!.toString()).not.toContain(org.users.emp2!.id);
    // The admins' list is theirs; mine is mine.
    expect((await org.admin.get('/v1/admin/data-exports')).body.items).toEqual([]);
  });
});

describe('erasure', () => {
  it('waits for another admin; a declined request says why', async () => {
    const mine = await org.admin.post('/v1/me/erasure-request', { reason: 'Testing' });
    expect((await org.admin.post(`/v1/admin/erasure-requests/${mine.body.id}/approve`)).status).toBe(403);

    const r = await org.users.emp!.client.post('/v1/me/erasure-request', { reason: 'Leaving the company' });
    expect(r.body).toMatchObject({ status: 'pending', user_name: 'pd emp', reason: 'Leaving the company' });
    expect((await org.users.emp!.client.post('/v1/me/erasure-request', {})).body.error.code).toBe('erasure_pending');
    const note = (await org.admin.get('/v1/me/notifications')).body.items.find((n: { kind: string }) => n.kind === 'erasure_request');
    expect(note).toMatchObject({ link: '/admin/requests' });
    expect((await org.users.manager!.client.post(`/v1/admin/erasure-requests/${r.body.id}/approve`)).status).toBe(403);
    expect((await org.admin.post(`/v1/admin/erasure-requests/${r.body.id}/decline`, {})).status).toBe(400);
    const declined = await org.admin.post(`/v1/admin/erasure-requests/${r.body.id}/decline`, { reason: 'Payroll for this month is still open.' });
    expect(declined.body).toMatchObject({ status: 'declined', decline_reason: 'Payroll for this month is still open.' });
    const told = (await org.users.emp!.client.get('/v1/me/notifications')).body.items.find((n: { kind: string }) => n.kind === 'erasure_declined');
    expect(told.body).toContain('Payroll for this month is still open.');
  });

  it('erases what Track measured except what a legal hold covers, keeps time records, and replaces name and email', async () => {
    const empId = org.users.emp!.id;
    const outside = await screenshot('2026-11-03T14:08:00Z');
    // A hold over the first five minutes keeps those buckets and the first screenshot.
    await org.admin.post('/v1/admin/legal-holds', { user_id: empId, from: '2026-11-03T14:00:00Z', to: '2026-11-03T14:05:30Z', reason: 'Dispute' });
    const sessionsBefore = await count('SELECT count(*)::int AS n FROM work_sessions WHERE user_id = $1', [empId]);

    const r = await org.users.emp!.client.post('/v1/me/erasure-request', { reason: 'Leaving' });
    const ok = await org.admin.post(`/v1/admin/erasure-requests/${r.body.id}/approve`);
    expect(ok.body.status).toBe('approved');
    // Deactivated straight away: no more sign-ins.
    await expect(login(env.app, 'emp@pd.test')).rejects.toThrow();

    const before = env.email.sent.length;
    await env.drain();
    const done = (await org.admin.get('/v1/admin/erasure-requests')).body.items.find((x: { id: string }) => x.id === r.body.id);
    expect(done.status).toBe('completed');
    expect(done.user_name).toBe('Erased person');
    expect(done.result.deleted).toMatchObject({ activity_buckets: 4, screenshots: 1 });
    expect(done.result.kept_for_legal_hold).toEqual({ activity_buckets: 6, screenshots: 1 });
    expect(env.store.objects.has(outside)).toBe(false);
    expect(await count('SELECT count(*)::int AS n FROM work_sessions WHERE user_id = $1', [empId])).toBe(sessionsBefore);
    expect(await count(`SELECT count(*)::int AS n FROM data_exports WHERE subject_user_id = $1`, [empId])).toBe(0);
    const u = (await sys(() => env.deps.pool.query('SELECT display_name, email, password_hash, status, erased_at FROM users WHERE id = $1', [empId]))).rows[0];
    expect(u).toMatchObject({ display_name: 'Erased person', email: `erased-${empId}@erased.invalid`, password_hash: null, status: 'deactivated' });
    expect(u.erased_at).toBeTruthy();

    const mail = env.email.sent.slice(before).filter((m) => m.subject.endsWith('was erased'));
    expect(mail.map((m) => m.to)).toEqual(['emp@pd.test']);
    expect(mail[0]!.text).toContain('Kept until a legal hold ends');
    expect((await org.admin.get('/v1/audit-events?action=user.erased')).body.items).toHaveLength(1);
    expect((await org.admin.post(`/v1/admin/users/${empId}/reactivate`)).body.error.code).toBe('erased');
  });
});
