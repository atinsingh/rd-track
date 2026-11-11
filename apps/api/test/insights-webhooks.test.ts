import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dailyInsights, focusBlocks, summarize, typicalDay, type InsightBucket } from '../src/modules/insights/compute';
import { assertPublicHttps } from '../src/modules/webhooks/service';
import {
  bucket,
  deviceReq,
  enrollDevice,
  event,
  makeOrg,
  minutes,
  PASSWORD,
  sendBatch,
  testEnv,
  type Org,
  type TestEnv,
} from './helpers';

/** Minute buckets for one session, `active` seconds each. */
function run(session: string, startIso: string, n: number, active = 45): InsightBucket[] {
  return minutes(startIso, n).map((m) => ({ session_id: session, bucket_start: m, active_seconds: active, idle_seconds: 60 - active, data_quality: 'ok' }));
}

describe('insight computation', () => {
  it('finds focus blocks of 30+ engaged minutes and tolerates two quiet minutes', () => {
    const b = [...run('s', '2026-10-26T14:00:00Z', 20), ...run('s', '2026-10-26T14:20:00Z', 2, 5), ...run('s', '2026-10-26T14:22:00Z', 18)];
    expect(focusBlocks(b)).toEqual([{ session_id: 's', start: '2026-10-26T14:00:00.000Z', minutes: 40 }]);
  });

  it('three quiet minutes, a gap or a new session end the block', () => {
    const quiet = [...run('s', '2026-10-26T14:00:00Z', 20), ...run('s', '2026-10-26T14:20:00Z', 3, 5), ...run('s', '2026-10-26T14:23:00Z', 20)];
    expect(focusBlocks(quiet)).toEqual([]);
    const sessions = [...run('a', '2026-10-26T14:00:00Z', 20), ...run('b', '2026-10-26T14:20:00Z', 20)];
    expect(focusBlocks(sessions)).toEqual([]);
    const gap = [...run('a', '2026-10-26T14:00:00Z', 20), ...run('a', '2026-10-26T14:25:00Z', 20)];
    expect(focusBlocks(gap)).toEqual([]);
  });

  it('never counts minutes without input permission as focus', () => {
    const b = run('s', '2026-10-26T14:00:00Z', 40).map((x) => ({ ...x, data_quality: 'permission_missing' as const }));
    expect(focusBlocks(b)).toEqual([]);
  });

  it('measures after-hours in the person’s own time zone, across the DST change', () => {
    const tz = 'America/Toronto';
    const hours = { start: '08:00', end: '18:00' };
    // 08:30 local on both sides of the 1 November change: inside working hours.
    const inHours = [...run('a', '2026-10-30T12:30:00Z', 10), ...run('b', '2026-11-02T13:30:00Z', 10)];
    expect(dailyInsights(inHours, tz, hours).map((d) => d.after_hours_seconds)).toEqual([0, 0]);
    // 07:30 EST after the change, 19:00 EDT before it: after hours.
    const outside = [...run('a', '2026-10-30T23:00:00Z', 10), ...run('b', '2026-11-02T12:30:00Z', 10)];
    expect(dailyInsights(outside, tz, hours).map((d) => [d.date, d.after_hours_seconds])).toEqual([
      ['2026-10-30', 600],
      ['2026-11-02', 600],
    ]);
  });

  it('flags weekends, long days and stretches without a break', () => {
    const tz = 'UTC';
    const hours = { start: '08:00', end: '18:00' };
    // Saturday: weekend time is not after-hours time.
    const sat = dailyInsights(run('s', '2026-10-24T10:00:00Z', 30), tz, hours);
    expect(sat[0]).toMatchObject({ weekend: true, after_hours_seconds: 0 });
    // Monday: 11 hours with one 15-minute break after 5 h → long day, longest stretch 6 h.
    const monday = [...run('s', '2026-10-26T07:00:00Z', 300), ...run('s', '2026-10-26T12:15:00Z', 360)];
    const [d] = dailyInsights(monday, tz, hours);
    expect(d!.long_day).toBe(true);
    expect(d!.longest_stretch_seconds).toBe(6 * 3600);
    expect(d!.after_hours_seconds).toBe(60 * 60 + 15 * 60); // 07:00–08:00 and 18:00–18:15
    const s = summarize([d!, ...sat]);
    expect(s).toMatchObject({ long_days: 1, breakless_days: 1, weekend_seconds: 30 * 60 });
  });

  it('averages the typical day over days with at least half an hour tracked', () => {
    const tz = 'Europe/London';
    const hours = { start: '08:00', end: '18:00' };
    // Mon 08:50–17:30 local (BST is over), Tue 09:10–17:50, Wed a 10-minute check-in that doesn't count.
    const idle = (b: InsightBucket[]) => b.map((x, i) => (i % 10 === 0 ? { ...x, active_seconds: 0, idle_seconds: 60 } : x));
    const days = dailyInsights(
      [...idle(run('a', '2026-10-26T08:50:00Z', 520, 60)), ...idle(run('b', '2026-10-27T09:10:00Z', 520, 60)), ...run('c', '2026-10-28T20:00:00Z', 10)],
      tz,
      hours,
    );
    expect(days.map((d) => [d.first_start, d.last_stop])).toEqual([
      ['08:50', '17:30'],
      ['09:10', '17:50'],
      ['20:00', '20:10'],
    ]);
    expect(days[0]!.idle_seconds).toBe(52 * 60);
    expect(typicalDay(days)).toEqual({ days: 2, start: '09:00', stop: '17:40', idle_seconds: 52 * 60 });
    expect(typicalDay([])).toEqual({ days: 0, start: null, stop: null, idle_seconds: null });
  });
});

describe('insights, categories and webhooks over the API', () => {
  let env: TestEnv;
  let org: Org;
  const deliveries: { url: string; headers: Record<string, string>; body: string }[] = [];
  let respondWith = 200;

  beforeAll(async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = 'true';
    env = await testEnv();
    env.deps.fetch = (async (url: string, init: RequestInit) => {
      deliveries.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response(null, { status: respondWith });
    }) as typeof fetch;
    org = await makeOrg(env, 'ins');
  });
  afterAll(async () => {
    delete process.env.WEBHOOKS_ALLOW_PRIVATE;
    await env.close();
  });

  it('gives each person their own insights, categorised by the organisation’s work apps', async () => {
    const put = await org.admin.put('/v1/admin/app-categories', { app_identifier: 'com.microsoft.VSCode', category: 'core_work' });
    expect(put.status).toBe(200);
    expect((await org.admin.get('/v1/admin/app-categories')).body.items).toHaveLength(1);
    // Upsert, case-insensitive: one rule per app.
    await org.admin.put('/v1/admin/app-categories', { app_identifier: 'com.microsoft.vscode', category: 'core_work' });
    expect((await org.admin.get('/v1/admin/app-categories')).body.items).toHaveLength(1);
    expect((await org.users.emp!.client.put('/v1/admin/app-categories', { app_identifier: 'x', category: 'core_work' })).status).toBe(403);

    const dev = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    const start = '2026-10-26T14:00:00Z';
    env.clock.t = new Date('2026-10-26T15:00:00Z').getTime();
    const r = await sendBatch(env, dev, [
      event(dev, sid, 'session.started.v1', { project_id: org.projectId }, start),
      ...minutes(start, 45).map((m) => bucket(dev, sid, m)),
      event(dev, sid, 'app_usage.v1', { app_identifier: 'com.microsoft.VSCode', app_name: 'Code', started_at: start, duration_seconds: 1800 }, '2026-10-26T14:30:00Z'),
      event(dev, sid, 'app_usage.v1', { app_identifier: 'com.spotify.client', app_name: 'Spotify', started_at: '2026-10-26T14:30:00Z', duration_seconds: 900 }, '2026-10-26T14:45:00Z'),
    ]);
    expect(r.body.results.filter((x: { status: string }) => x.status !== 'accepted')).toEqual([]);
    await env.drain();

    const q = 'from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z&tz=America/Toronto';
    const mine = await org.users.emp!.client.get(`/v1/me/insights?${q}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ tracked_seconds: 45 * 60, focus: { blocks: 1, seconds: 45 * 60, share_percent: 100 } });
    expect(mine.body.work_apps).toEqual([
      { category: 'core_work', seconds: 1800 },
      { category: 'uncategorized', seconds: 900 },
    ]);
    const apps = await org.users.emp!.client.get(`/v1/me/apps?${q}`);
    expect(apps.body.apps.find((a: { app_name: string }) => a.app_name === 'Code').category).toBe('core_work');
    expect((await org.users.emp!.client.get(`/v1/me/insights?${q.replace('America/Toronto', 'Mars/Base')}`)).status).toBe(400);
    expect(mine.body.typical_day).toEqual({ days: 1, start: '10:00', stop: '10:45', idle_seconds: 45 * 15 });
  });

  it('applies the AI-tools preset as ordinary rules, all or a chosen few', async () => {
    const some = await org.admin.post('/v1/admin/app-categories/presets', { preset: 'ai_tools', category: 'supporting', identifiers: ['com.openai.chat', 'Cursor.exe'] });
    expect(some.body).toEqual({ applied: 2 });
    const all = await org.admin.post('/v1/admin/app-categories/presets', { preset: 'ai_tools', category: 'core_work' });
    expect(all.body.applied).toBe(12);
    const rules = (await org.admin.get('/v1/admin/app-categories')).body.items as { app_identifier: string; category: string }[];
    expect(rules.find((r) => r.app_identifier === 'com.openai.chat')!.category).toBe('core_work');
    expect(rules.filter((r) => r.category === 'core_work')).toHaveLength(13); // the preset and VS Code
    const bad = await org.admin.post('/v1/admin/app-categories/presets', { preset: 'ai_tools', category: 'core_work', identifiers: ['Spotify.exe'] });
    expect(bad.status).toBe(400);
    expect((await org.users.emp!.client.post('/v1/admin/app-categories/presets', { preset: 'ai_tools', category: 'core_work' })).status).toBe(403);
    expect((await org.admin.get('/v1/audit-events?action=app_category.preset_applied')).body.items).toHaveLength(2);
  });

  it('shows team insights only as aggregates, and only for five or more people', async () => {
    const path = `/v1/teams/${org.teamId}/insights?from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z`;
    const small = await org.users.manager!.client.get(path);
    expect(small.status).toBe(403);
    expect(small.body.error.code).toBe('insufficient_group_size');
    for (const name of ['emp3', 'emp4']) {
      const u = await org.admin.post('/v1/admin/users', { email: `${name}@ins.test`, display_name: name, password: PASSWORD });
      await org.admin.post(`/v1/admin/teams/${org.teamId}/members`, { user_id: u.body.user.id, role: 'member' });
    }
    const team = await org.users.manager!.client.get(path);
    expect(team.status).toBe(200);
    expect(team.body.member_count).toBe(5);
    expect(team.body.per_person.tracked_seconds).toBe(Math.round((45 * 60) / 5));
    expect(JSON.stringify(team.body)).not.toContain(org.users.emp!.id);
    // Employees don't manage the team.
    expect((await org.users.emp!.client.get(path)).status).toBe(403);
  });

  it('team insights and webhooks are Pro features', async () => {
    const std = await makeOrg(env, 'insstd', 'standard');
    expect((await std.users.manager!.client.get(`/v1/teams/${std.teamId}/insights`)).status).toBe(402);
    expect((await std.admin.get('/v1/admin/webhooks')).status).toBe(402);
    // Personal insights are on every plan.
    expect((await std.users.emp!.client.get('/v1/me/insights?from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z')).status).toBe(200);
  });

  it('only accepts public https webhook URLs', async () => {
    expect((await org.admin.post('/v1/admin/webhooks', { url: 'http://hooks.example.com/x', events: ['session.started'] })).status).toBe(400);
    delete process.env.WEBHOOKS_ALLOW_PRIVATE;
    try {
      for (const url of ['https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://[::1]/x', 'https://169.254.169.254/latest']) {
        await expect(assertPublicHttps(url)).rejects.toMatchObject({ code: 'webhook_url_not_public' });
      }
      await expect(assertPublicHttps('https://8.8.8.8/hook')).resolves.toBeUndefined();
    } finally {
      process.env.WEBHOOKS_ALLOW_PRIVATE = 'true';
    }
  });

  it('signs and delivers subscribed events, retrying failures', async () => {
    const created = await org.admin.post('/v1/admin/webhooks', {
      url: 'https://hooks.example.com/rd',
      description: 'Payroll sync',
      events: ['session.started', 'session.stopped'],
    });
    expect(created.status).toBe(201);
    const secret: string = created.body.signing_secret;
    expect(secret).toMatch(/^whsec_/);
    const listed = await org.admin.get('/v1/admin/webhooks');
    expect(listed.body.items[0]).not.toHaveProperty('signing_secret');

    const dev = await enrollDevice(env, org, 'emp2');
    const sid = randomUUID();
    deliveries.length = 0;
    await sendBatch(env, dev, [
      event(dev, sid, 'session.started.v1', {}, env.clock.iso(-120_000)),
      event(dev, sid, 'session.stopped.v1', { reason: 'user' }, env.clock.iso(-60_000)),
    ]);
    await env.drain();
    expect(deliveries.map((d) => d.headers['x-rd-event'])).toEqual(['session.started', 'session.stopped']);
    for (const d of deliveries) {
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(d.headers['x-rd-signature']!)!;
      expect(createHmac('sha256', secret).update(`${t}.${d.body}`).digest('hex')).toBe(v1);
      const payload = JSON.parse(d.body);
      expect(payload).toMatchObject({ organization_id: org.id, data: { session_id: sid, user_id: org.users.emp2!.id } });
      // Ids and timestamps only: no names, apps or activity.
      expect(d.body).not.toContain('ins emp2');
    }

    // A failing endpoint: the attempt is recorded and the job is retried later.
    respondWith = 500;
    deliveries.length = 0;
    expect((await org.admin.post(`/v1/admin/webhooks/${created.body.id}/test`)).status).toBe(200);
    await env.drain();
    expect(deliveries).toHaveLength(1);
    let log = await org.admin.get(`/v1/admin/webhooks/${created.body.id}/deliveries`);
    expect(log.body.items[0]).toMatchObject({ event_type: 'webhook.test', status: 'pending', attempts: 1, last_status_code: 500 });

    // Exhaust the retries: the delivery is marked failed for admins to see.
    await env.deps.pool.query(`UPDATE jobs SET run_at = now(), attempts = max_attempts - 1 WHERE kind = 'webhook.deliver' AND status = 'queued'`);
    await env.drain();
    log = await org.admin.get(`/v1/admin/webhooks/${created.body.id}/deliveries`);
    expect(log.body.items[0]).toMatchObject({ status: 'failed', attempts: 2 });
    respondWith = 200;

    expect((await org.admin.req('DELETE', `/v1/admin/webhooks/${created.body.id}`)).status).toBe(200);
    expect((await org.admin.post(`/v1/admin/webhooks/${created.body.id}/test`)).status).toBe(404);
  });

  it('keeps each organisation’s webhooks and categories to itself', async () => {
    const other = await makeOrg(env, 'insother');
    const hook = await org.admin.post('/v1/admin/webhooks', { url: 'https://hooks.example.com/a', events: ['export.ready'] });
    expect((await other.admin.get(`/v1/admin/webhooks/${hook.body.id}/deliveries`)).body.items).toEqual([]);
    expect((await other.admin.req('DELETE', `/v1/admin/webhooks/${hook.body.id}`)).status).toBe(404);
    expect((await other.admin.get('/v1/admin/app-categories')).body.items).toEqual([]);
  });
});

describe('tray app support', () => {
  let env: TestEnv;
  afterAll(() => env.close());
  beforeAll(async () => {
    env = await testEnv();
  });

  it('lists the projects and open tasks the device’s user may book time to', async () => {
    const org = await makeOrg(env, 'tray');
    await org.admin.post(`/v1/admin/projects/${org.projectId}/tasks`, { name: 'Design review' });
    const restricted = await org.admin.post('/v1/admin/projects', { name: 'Restricted' });
    await org.admin.post(`/v1/admin/projects/${restricted.body.id}/members`, { user_id: org.users.manager!.id, role: 'member' });
    const dev = await enrollDevice(env, org, 'emp');
    const r = await deviceReq(env, dev, 'GET', '/v1/device/projects');
    expect(r.status).toBe(200);
    expect(r.body.projects).toEqual([{ id: org.projectId, name: 'tray Project', tasks: [{ id: expect.any(String), name: 'Design review' }] }]);
    expect((await env.app.inject({ method: 'GET', url: '/v1/device/projects' })).statusCode).toBe(401);
  });

  it('tells the agent where the employee’s dashboard is', async () => {
    const org = await makeOrg(env, 'tray2');
    const code = await org.admin.post('/v1/admin/enrollment-codes', { user_id: org.users.emp!.id });
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      payload: { enrollment_code: code.body.code, device_name: 'Mac', os: 'macos', os_version: '15.6', agent_version: '0.1.0' },
    });
    const enrolled = JSON.parse(res.body);
    expect(enrolled.dashboard_url).toBe(`${env.deps.config.webUrl}/me`);
    const hb = await env.app.inject({
      method: 'POST',
      url: '/v1/device/heartbeat',
      headers: { authorization: `Device ${enrolled.device_credential}` },
      payload: {
        agent_version: '0.1.0',
        client_time: env.clock.iso(),
        permissions: { input_monitoring: 'granted', screen_recording: 'granted', accessibility: 'not_required' },
        outbox_depth: 0,
        applied_policy_revision: null,
      },
    });
    expect(JSON.parse(hb.body).dashboard_url).toBe(enrolled.dashboard_url);
  });
});
