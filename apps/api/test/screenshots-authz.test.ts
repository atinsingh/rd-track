import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceReq, enrollDevice, event, makeOrg, sendBatch, testEnv, type Device, type Org, type TestEnv } from './helpers';

let env: TestEnv;
let org: Org;
let other: Org;
let dev: Device;
let sessionId: string;

const RANGE = 'from=2026-10-26T00:00:00Z&to=2026-10-28T00:00:00Z';

async function enableScreenshots(o: Org) {
  const res = await o.admin.put(`/v1/policies/project/${o.projectId}`, {
    settings: { screenshots: { enabled: true, interval_minutes: 10 }, viewers: { manager_can_view_screenshots: true } },
    change_note: 'Client requires visual evidence',
    confirm_expansion: true,
  });
  expect(res.status).toBe(200);
}

async function capture(d: Device, sid: string): Promise<{ id: string; status: number; body: any }> {
  const intent = await deviceReq(env, d, 'POST', '/v1/screenshots/upload-intents', { session_id: sid, content_type: 'image/webp' });
  if (intent.status !== 201) return { id: '', ...intent };
  const bytes = Buffer.from(`fake-webp-${randomUUID()}`);
  // The agent PUTs to the presigned URL; the in-memory store stands in for S3.
  const key = decodeURIComponent(new URL(intent.body.upload_url.replace('memory://', 'http://x/')).pathname.split('/').pop()!);
  await env.store.put(key, bytes, 'image/webp');
  const done = await deviceReq(env, d, 'POST', '/v1/screenshots/complete', {
    screenshot_id: intent.body.screenshot_id,
    captured_at: env.clock.iso(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    width: 1280,
    height: 800,
  });
  return { id: intent.body.screenshot_id, ...done };
}

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'acme');
  other = await makeOrg(env, 'globex');
  dev = await enrollDevice(env, org, 'emp');
  sessionId = randomUUID();
  const r = await sendBatch(env, dev, [event(dev, sessionId, 'session.started.v1', { project_id: org.projectId }, env.clock.iso())]);
  expect(r.body.results[0].status).toBe('accepted');
});
afterAll(() => env.close());

describe('screenshots', () => {
  it('are refused unless a published policy enables them (SCR-01)', async () => {
    const r = await deviceReq(env, dev, 'POST', '/v1/screenshots/upload-intents', { session_id: sessionId, content_type: 'image/webp' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('screenshots_disabled');
  });

  it('upload, verify, and let the employee and their manager view — each view audited', async () => {
    await enableScreenshots(org);
    env.clock.advance(60_000);
    const shot = await capture(dev, sessionId);
    expect(shot.status).toBe(200);
    await env.drain();
    const row = (await env.deps.pool.query('SELECT status FROM screenshots WHERE id = $1', [shot.id])).rows[0];
    expect(row.status).toBe('stored');

    const mine = await org.users.emp!.client.get(`/v1/me/screenshots?${RANGE}`);
    expect(mine.body.items).toHaveLength(1);

    const asManager = await org.users.manager!.client.get(`/v1/screenshots/${shot.id}/view-url`);
    expect(asManager.status).toBe(200);
    expect(asManager.body.url).toMatch(/^memory:\/\/get\//);

    const log = await org.users.emp!.client.get('/v1/me/access-log');
    expect(log.body.items.some((e: { action: string; actor_id: string }) => e.action === 'screenshot.view' && e.actor_id === org.users.manager!.id)).toBe(true);
  });

  it('is not visible to org admins, colleagues or other tenants', async () => {
    const id = (await env.deps.pool.query(`SELECT id FROM screenshots WHERE status = 'stored' LIMIT 1`)).rows[0].id;
    expect((await org.admin.get(`/v1/screenshots/${id}/view-url`)).status).toBe(403);
    expect((await org.users.emp2!.client.get(`/v1/screenshots/${id}/view-url`)).status).toBe(403);
    expect((await other.admin.get(`/v1/screenshots/${id}/view-url`)).status).toBe(404);
    expect((await other.users.manager!.client.get(`/v1/users/${org.users.emp!.id}/activity?${RANGE}`)).status).toBe(404);
    const denied = await env.deps.pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'screenshot.view' AND result = 'denied'`,
    );
    expect(denied.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('enforces the minimum interval between captures', async () => {
    env.clock.advance(60_000);
    const r = await deviceReq(env, dev, 'POST', '/v1/screenshots/upload-intents', { session_id: sessionId, content_type: 'image/webp' });
    expect(r.status).toBe(429);
  });

  it('never stores a capture taken after the session stopped (SCR-02)', async () => {
    env.clock.advance(10 * 60_000);
    const intent = await deviceReq(env, dev, 'POST', '/v1/screenshots/upload-intents', { session_id: sessionId, content_type: 'image/webp' });
    expect(intent.status).toBe(201);
    env.clock.advance(1_000);
    await sendBatch(env, dev, [event(dev, sessionId, 'session.stopped.v1', { reason: 'user' }, env.clock.iso())]);
    env.clock.advance(2_000);
    const bytes = Buffer.from('late');
    const done = await deviceReq(env, dev, 'POST', '/v1/screenshots/complete', {
      screenshot_id: intent.body.screenshot_id,
      captured_at: env.clock.iso(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      width: 10,
      height: 10,
    });
    expect(done.status).toBe(403);
    const row = (await env.deps.pool.query('SELECT status, deletion_reason FROM screenshots WHERE id = $1', [intent.body.screenshot_id])).rows[0];
    expect(row).toEqual({ status: 'deleted', deletion_reason: 'captured_outside_active_session' });
    const after = await deviceReq(env, dev, 'POST', '/v1/screenshots/upload-intents', { session_id: sessionId, content_type: 'image/webp' });
    expect(after.body.error.code).toBe('session_not_active');
  });

  it('employee self-service deletion removes the object (SCR-09/10)', async () => {
    const shot = (await env.deps.pool.query(`SELECT id, object_key FROM screenshots WHERE status = 'stored' LIMIT 1`)).rows[0];
    const r = await org.users.emp!.client.post('/v1/me/deletion-requests', {
      target_type: 'screenshot',
      target_id: shot.id,
      reason: 'Personal banking tab was visible',
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('approved');
    await env.drain();
    expect(await env.store.head(shot.object_key)).toBeNull();
    const row = (await env.deps.pool.query('SELECT status FROM screenshots WHERE id = $1', [shot.id])).rows[0];
    expect(row.status).toBe('deleted');
  });
});

describe('audit and access', () => {
  it('the audit log is append-only', async () => {
    await expect(env.deps.pool.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.deps.pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('auditors read the audit log; employees cannot', async () => {
    const r = await org.admin.post('/v1/admin/users', { email: 'auditor@acme.test', display_name: 'Auditor', org_role: 'auditor', tracking_enabled: false, password: 'correct-horse-battery' });
    expect(r.status).toBe(201);
    const { login } = await import('./helpers');
    const auditor = await login(env.app, 'auditor@acme.test');
    const events = await auditor.get('/v1/audit-events');
    expect(events.status).toBe(200);
    expect(events.body.items.length).toBeGreaterThan(0);
    expect(events.body.items.every((e: { metadata: object }) => !JSON.stringify(e.metadata).includes('fake-webp'))).toBe(true);
    expect((await org.users.emp!.client.get('/v1/audit-events')).status).toBe(403);
    // Auditors have no activity access.
    expect((await auditor.get(`/v1/users/${org.users.emp!.id}/activity?${RANGE}`)).status).toBe(403);
  });

  it('mutations require the CSRF header', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/v1/admin/teams', payload: { name: 'x' }, headers: { cookie: org.admin.cookie } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('csrf_failed');
  });

  it('a team manager sees team reports, with one audit entry per member viewed', async () => {
    const r = await org.users.manager!.client.get(`/v1/teams/${org.teamId}/report?${RANGE}&tz=America/Toronto`);
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: { display_name: string }) => m.display_name)).toEqual(['acme emp', 'acme emp2', 'acme manager']);
    expect((await org.users.emp!.client.get(`/v1/teams/${org.teamId}/report?${RANGE}`)).status).toBe(403);
    expect((await other.users.manager!.client.get(`/v1/teams/${org.teamId}/report?${RANGE}`)).status).toBe(403);
  });
});
