import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceReq, enrollDevice, event, makeOrg, sendBatch, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** SCR-12: screenshots blurred on the computer, before upload, when the policy says so. */

let env: TestEnv;
let org: Org;
let dev: Device;
let sessionId: string;

afterAll(async () => {
  await env.close();
});
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'blurco');
  dev = await enrollDevice(env, org, 'emp');
  sessionId = randomUUID();
  await sendBatch(env, dev, [event(dev, sessionId, 'session.started.v1', { project_id: org.projectId }, env.clock.iso())]);
});

async function policy(screenshots: object) {
  const r = await org.admin.put(`/v1/policies/project/${org.projectId}`, {
    settings: { screenshots: { enabled: true, interval_minutes: 10, ...screenshots } },
    change_note: 'Screenshots for the client',
    confirm_expansion: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

/** One capture: the intent, the upload, and the completion the agent reports. */
async function capture(blurred: boolean | undefined) {
  env.clock.advance(11 * 60_000);
  const intent = await deviceReq(env, dev, 'POST', '/v1/screenshots/upload-intents', { session_id: sessionId, content_type: 'image/jpeg' });
  expect(intent.status).toBe(201);
  const bytes = Buffer.from(`jpeg-${randomUUID()}`);
  const key = decodeURIComponent(new URL(intent.body.upload_url.replace('memory://', 'http://x/')).pathname.split('/').pop()!);
  await env.store.put(key, bytes, 'image/jpeg');
  const done = await deviceReq(env, dev, 'POST', '/v1/screenshots/complete', {
    screenshot_id: intent.body.screenshot_id,
    captured_at: env.clock.iso(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    width: 1280,
    height: 720,
    ...(blurred === undefined ? {} : { blurred }),
  });
  await env.drain();
  const row = (await env.deps.pool.query('SELECT status, deletion_reason, blurred, object_key FROM screenshots WHERE id = $1', [intent.body.screenshot_id])).rows[0];
  return { intent: intent.body, done, row };
}

describe('blurred screenshots', () => {
  it('are sharp unless a policy blurs them', async () => {
    await policy({});
    const c = await capture(false);
    expect(c.intent.blur).toBe(false);
    expect(c.row).toMatchObject({ status: 'stored', blurred: false });
  });

  it('when the policy blurs them, the agent is told and only a blurred image is stored', async () => {
    await policy({ blur: true });
    const ok = await capture(true);
    expect(ok.intent.blur).toBe(true);
    expect(ok.row).toMatchObject({ status: 'stored', blurred: true });
    const mine = await org.users.emp!.client.get(`/v1/me/screenshots?from=${env.clock.iso(-86_400_000)}&to=${env.clock.iso(60_000)}`);
    expect(mine.body.items.map((s: { blurred: boolean }) => s.blurred)).toEqual([false, true]);

    // An older agent that doesn't blur: the image is deleted, never stored.
    for (const blurred of [undefined, false]) {
      const old = await capture(blurred);
      expect(old.done.status).toBe(403);
      expect(old.done.body.error.code).toBe('blur_required');
      expect(old.row).toMatchObject({ status: 'deleted', deletion_reason: 'not_blurred' });
      expect(await env.store.head(old.row.object_key)).toBeNull();
    }
  });

  it('turning blur off is an expansion people are told about', async () => {
    const off = await org.admin.put(`/v1/policies/project/${org.projectId}`, {
      settings: { screenshots: { enabled: true, interval_minutes: 10, blur: false } },
      change_note: 'Sharp screenshots again',
    });
    expect(off.status).toBe(409);
    expect(JSON.stringify(off.body)).toContain('screenshots.blur');
  });
});
