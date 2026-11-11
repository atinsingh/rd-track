import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, deviceReq, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** Website domains (Pro): the browser extension tells the app, the app tells the server. */

let env: TestEnv;
afterAll(async () => {
  await env.close();
});
beforeAll(async () => {
  env = await testEnv();
});

const heartbeat = (dev: Device, extra: object = {}) =>
  deviceReq(env, dev, 'POST', '/v1/device/heartbeat', {
    agent_version: '0.2.0',
    client_time: env.clock.iso(),
    permissions: { input_monitoring: 'granted', screen_recording: 'granted', accessibility: 'not_required' },
    outbox_depth: 0,
    applied_policy_revision: null,
    ...extra,
  });

/** One session in which `app` shows github.com; returns every app and domain the person has. */
async function browse(org: Org, dev: Device, app: string, hoursAgo: number) {
  const sid = randomUUID();
  const start = env.clock.iso(-hoursAgo * 3_600_000);
  const r = await sendBatch(env, dev, [
    event(dev, sid, 'session.started.v1', { project_id: org.projectId }, start),
    ...minutes(start, 10).map((m) => bucket(dev, sid, m)),
    event(dev, sid, 'app_usage.v1', { app_identifier: app, app_name: app, domain: 'github.com', started_at: start, duration_seconds: 300 }, start),
  ]);
  expect(r.body.results.filter((x: { status: string }) => x.status !== 'accepted')).toEqual([]);
  await env.drain();
  const apps = await org.users.emp!.client.get(`/v1/me/apps?from=${env.clock.iso(-86_400_000)}&to=${env.clock.iso(3_600_000)}&tz=UTC`);
  expect(apps.status, JSON.stringify(apps.body)).toBe(200);
  return Object.fromEntries(apps.body.apps.map((a: { app_identifier: string; domain: string | null }) => [a.app_identifier, a.domain]));
}

describe('website domains', () => {
  it('are a Pro feature', async () => {
    const org = await makeOrg(env, 'domstd', 'standard', 5);
    const r = await org.admin.put(`/v1/policies/organization/${org.id}`, { settings: { apps: { capture_domains: true } }, change_note: 'Record domains', confirm_expansion: true });
    expect(r.status).toBe(402);
  });

  it('are kept only while the policy records them', async () => {
    const org = await makeOrg(env, 'dompro', 'pro', 5);
    const dev = await enrollDevice(env, org, 'emp');
    // An agent that sends one anyway (old, or tampered with): the server drops it.
    expect(await browse(org, dev, 'com.google.Chrome', 5)).toEqual({ 'com.google.Chrome': null });

    const on = await org.admin.put(`/v1/policies/organization/${org.id}`, { settings: { apps: { capture_domains: true } }, change_note: 'Record website domains', confirm_expansion: true });
    expect(on.status).toBe(200);
    expect(await browse(org, dev, 'org.mozilla.firefox', 3)).toEqual({ 'com.google.Chrome': null, 'org.mozilla.firefox': 'github.com' });
    // Only a hostname is ever accepted.
    const sid = randomUUID();
    const bad = await sendBatch(env, dev, [
      event(dev, sid, 'app_usage.v1', { app_identifier: 'com.google.Chrome', app_name: 'Chrome', domain: 'github.com/rd/track?q=1', started_at: env.clock.iso(-60_000), duration_seconds: 60 }, env.clock.iso()),
    ]);
    expect(bad.body.results[0].status).toBe('rejected');
  });

  it('heartbeats say which browsers have the extension', async () => {
    const org = await makeOrg(env, 'domhb', 'pro', 5);
    const dev = await enrollDevice(env, org, 'emp');
    expect((await heartbeat(dev)).status).toBe(200);
    expect((await org.admin.get('/v1/admin/devices')).body.items[0].browser_extensions).toEqual([]);
    expect((await heartbeat(dev, { browser_extensions: ['firefox', 'chromium', 'firefox'] })).status).toBe(200);
    expect((await org.admin.get('/v1/admin/devices')).body.items[0].browser_extensions).toEqual(['chromium', 'firefox']);
    expect((await org.users.emp!.client.get('/v1/me/devices')).body.items[0].browser_extensions).toEqual(['chromium', 'firefox']);
    expect((await heartbeat(dev, { browser_extensions: ['safari'] })).status).toBe(400);
    // An app without it says nothing: none.
    await heartbeat(dev);
    expect((await org.admin.get('/v1/admin/devices')).body.items[0].browser_extensions).toEqual([]);
  });

  it('lists where to get the extension, once it is published', async () => {
    const { agentDownloads } = await import('../src/modules/workspaces-routes');
    expect(agentDownloads({ baseUrl: null, version: null }).extensions).toEqual([]);
    const d = agentDownloads({ baseUrl: null, version: null }, undefined, { chrome: 'https://chromewebstore.google.com/detail/x', edge: null, firefox: 'https://addons.mozilla.org/firefox/addon/x' });
    expect(d.extensions.map((e) => e.browser)).toEqual(['chrome', 'firefox']);
  });
});
