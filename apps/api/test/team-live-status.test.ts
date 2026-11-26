import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { bucket, deviceReq, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** The team overview says what each person is doing right now, and how many screenshots the range holds. */

let env: TestEnv;
let org: Org;
let dev: Device;
const sid = randomUUID();

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'liveco');
  dev = await enrollDevice(env, org, 'emp');
});

type Row = { user_id: string; status: string; screenshot_count: number | null };
async function rowFor(userKey: string): Promise<Row> {
  const range = `from=${env.clock.iso(-86_400_000)}&to=${env.clock.iso(3_600_000)}`;
  const res = await org.users.manager!.client.get(`/v1/teams/${org.teamId}/report?${range}`);
  expect(res.status).toBe(200);
  return res.body.members.find((m: Row) => m.user_id === org.users[userKey]!.id);
}
async function send(events: object[]) {
  const r = await sendBatch(env, dev, events);
  expect(r.body.results.filter((x: { status: string }) => x.status !== 'accepted')).toEqual([]);
  await env.drain();
}
const minute = (offsetMs: number) => env.clock.iso(offsetMs).slice(0, 16) + ':00.000Z';

describe('team live status', () => {
  it('is offline without an open session', async () => {
    expect((await rowFor('emp')).status).toBe('offline');
  });

  it('is tracking while the computer reports activity, idle after minutes without input', async () => {
    const start = minute(-10 * 60_000);
    await send([event(dev, sid, 'session.started.v1', { project_id: org.projectId }, start), ...minutes(start, 2).map((m) => bucket(dev, sid, m))]);
    // Two active minutes, then eight with no input up to now.
    await send(minutes(minute(-8 * 60_000), 8).map((m) => bucket(dev, sid, m, 0, 60)));
    expect((await rowFor('emp')).status).toBe('idle');
    await send([bucket(dev, sid, minute(0))]);
    expect((await rowFor('emp')).status).toBe('tracking');
  });

  it('is paused while the session is paused', async () => {
    env.clock.advance(60_000);
    await send([event(dev, sid, 'session.paused.v1', { reason: 'user' }, env.clock.iso())]);
    expect((await rowFor('emp')).status).toBe('paused');
  });

  it('turns offline when the computer stops reporting', async () => {
    env.clock.advance(10 * 60_000);
    expect((await rowFor('emp')).status).toBe('offline');
  });

  it('counts screenshots only for people whose screenshots are shared with the viewer', async () => {
    // The default policy doesn't share screenshots with managers.
    expect((await rowFor('emp')).screenshot_count).toBeNull();
    // Shared on the project the person tracks, as most setups do.
    const res = await org.admin.put(`/v1/policies/project/${org.projectId}`, {
      settings: { screenshots: { enabled: true, interval_minutes: 10 }, viewers: { manager_can_view_screenshots: true } },
      change_note: 'Visual evidence for client work',
      confirm_expansion: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rowFor('emp')).screenshot_count).toBe(0);

    await send([event(dev, sid, 'session.resumed.v1', {}, env.clock.iso())]);
    const intent = await deviceReq(env, dev, 'POST', '/v1/screenshots/upload-intents', { session_id: sid, content_type: 'image/webp' });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const bytes = Buffer.from('fake-webp');
    const key = decodeURIComponent(new URL(intent.body.upload_url.replace('memory://', 'http://x/')).pathname.split('/').pop()!);
    await env.store.put(key, bytes, 'image/webp');
    const done = await deviceReq(env, dev, 'POST', '/v1/screenshots/complete', {
      screenshot_id: intent.body.screenshot_id,
      captured_at: env.clock.iso(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      width: 1280,
      height: 800,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await env.drain();
    expect((await rowFor('emp')).screenshot_count).toBe(1);
    // Nothing on that project for this person, so nothing is shared.
    expect((await rowFor('emp2')).screenshot_count).toBeNull();
  });

  it('leaves out screenshots from sessions outside a project that shares them', async () => {
    // A session with no project: the org policy doesn't share screenshots, so its screenshot must not count.
    const other = randomUUID();
    await send([event(dev, other, 'session.started.v1', {}, env.clock.iso())]);
    await withScope(SYSTEM_SCOPE, () =>
      env.deps.pool.query(
        `INSERT INTO screenshots (id, organization_id, session_id, user_id, device_id, object_key, content_type, status, captured_at, policy_revision, intent_expires_at, retention_after)
         VALUES ($1, $2, $3, $4, $5, $6, 'image/webp', 'stored', $7, 1, $7, '2027-01-01T00:00:00Z')`,
        [randomUUID(), org.id, other, org.users.emp!.id, dev.id, `k-${randomUUID()}`, env.clock.iso()],
      ),
    );
    expect((await rowFor('emp')).screenshot_count).toBe(1);
  });
});
