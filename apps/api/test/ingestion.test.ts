import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bucket,
  deviceReq,
  enrollDevice,
  event,
  makeOrg,
  minutes,
  sendBatch,
  testEnv,
  type Device,
  type Org,
  type TestEnv,
} from './helpers';

let env: TestEnv;
let org: Org;
let dev: Device;

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'acme');
  dev = await enrollDevice(env, org, 'emp');
});
afterAll(() => env.close());

const count = async (sql: string, params: unknown[] = []) => Number((await env.deps.pool.query(sql, params)).rows[0].n);

describe('work sessions and ingestion', () => {
  it('records a session with minute buckets and reports activity', async () => {
    const sid = randomUUID();
    const start = '2026-10-26T13:00:00.000Z';
    env.clock.t = new Date('2026-10-26T13:10:30Z').getTime();
    const events = [
      event(dev, sid, 'session.started.v1', { project_id: org.projectId }, start),
      ...minutes(start, 10).map((m) => bucket(dev, sid, m, 40, 20)),
    ];
    const res = await sendBatch(env, dev, events);
    expect(res.status).toBe(200);
    expect(res.body.results.every((r: { status: string }) => r.status === 'accepted')).toBe(true);

    await env.drain();
    expect(await count('SELECT count(*) AS n FROM activity_buckets WHERE session_id = $1', [sid])).toBe(10);

    const act = await org.users.emp!.client.get(`/v1/me/activity?from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z`);
    expect(act.status).toBe(200);
    expect(act.body.totals.tracked_seconds).toBe(600);
    expect(act.body.totals.activity_percent).toBe(67);
  });

  it('is idempotent: replaying a batch creates nothing new', async () => {
    const sid = randomUUID();
    const start = '2026-10-26T14:00:00.000Z';
    env.clock.t = new Date('2026-10-26T14:05:30Z').getTime();
    const events = [event(dev, sid, 'session.started.v1', {}, start), ...minutes(start, 5).map((m) => bucket(dev, sid, m))];
    const first = await sendBatch(env, dev, events);
    const before = await count('SELECT count(*) AS n FROM ingest_events');
    const replay = await sendBatch(env, dev, events);
    expect(replay.body.results.map((r: { status: string }) => r.status)).toEqual(events.map(() => 'duplicate'));
    expect(await count('SELECT count(*) AS n FROM ingest_events')).toBe(before);
    expect(first.body.results.filter((r: { status: string }) => r.status === 'accepted')).toHaveLength(6);
    await env.drain();
    expect(await count('SELECT count(*) AS n FROM activity_buckets WHERE session_id = $1', [sid])).toBe(5);
    expect(await count('SELECT count(*) AS n FROM work_sessions WHERE id = $1', [sid])).toBe(1);
  });

  it('a laptop asleep for two hours adds no tracked time, only a gap', async () => {
    const sid = randomUUID();
    const start = '2026-10-26T16:00:00.000Z';
    env.clock.t = new Date('2026-10-26T18:06:00Z').getTime();
    const events = [
      event(dev, sid, 'session.started.v1', {}, start),
      ...minutes(start, 3).map((m) => bucket(dev, sid, m, 60, 0)),
      event(dev, sid, 'data_gap.v1', { gap_start: '2026-10-26T16:03:00Z', gap_end: '2026-10-26T18:03:00Z', reason: 'suspended' }, '2026-10-26T18:03:00Z'),
      ...minutes('2026-10-26T18:03:00.000Z', 2).map((m) => bucket(dev, sid, m, 60, 0)),
      event(dev, sid, 'session.stopped.v1', { reason: 'user' }, '2026-10-26T18:05:00Z'),
    ];
    const res = await sendBatch(env, dev, events);
    expect(res.body.results.every((r: { status: string }) => r.status === 'accepted')).toBe(true);
    await env.drain();
    const sessions = await org.users.emp!.client.get(`/v1/me/sessions?from=2026-10-26T15:00:00Z&to=2026-10-26T19:00:00Z`);
    const s = sessions.body.items.find((x: { id: string }) => x.id === sid);
    expect(s.tracked_seconds).toBe(300); // 5 measured minutes, not 2h05m of wall clock
    const act = await org.users.emp!.client.get(`/v1/me/activity?from=2026-10-26T15:00:00Z&to=2026-10-26T19:00:00Z`);
    expect(act.body.totals.gap_seconds).toBe(7200);
    expect(act.body.totals.idle_seconds).toBe(0);
  });

  it('rejects payloads with fields the product must never collect', async () => {
    const sid = randomUUID();
    const e = event(dev, sid, 'session.started.v1', {}, env.clock.iso());
    const bad = { ...bucket(dev, sid, '2026-10-26T18:05:00.000Z'), payload: { ...bucket(dev, sid, '2026-10-26T18:05:00.000Z').payload, typed_text: 'secret' } };
    const res = await sendBatch(env, dev, [e, bad]);
    expect(res.body.results[0].status).toBe('accepted');
    expect(res.body.results[1].status).toBe('rejected');
    expect(res.body.results[1].reason).toMatch(/invalid_event/);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('prevents overlapping sessions across devices', async () => {
    const dev2 = await enrollDevice(env, org, 'emp');
    const busy = (await env.deps.pool.query(`SELECT id FROM work_sessions WHERE user_id = $1 AND state = 'active'`, [dev.userId])).rows;
    expect(busy.length).toBeGreaterThan(0);
    const sid = randomUUID();
    const res = await sendBatch(env, dev2, [
      event(dev2, sid, 'session.started.v1', {}, env.clock.iso()),
      bucket(dev2, sid, new Date(Math.floor(env.clock.t / 60_000) * 60_000).toISOString()),
      event(dev2, sid, 'session.stopped.v1', { reason: 'overlap' }, env.clock.iso()),
    ]);
    expect(res.body.results.map((r: { reason?: string }) => r.reason)).toEqual(['overlapping_session', 'unknown_session', 'unknown_session']);
  });

  it('rejects events for another device and buckets outside the session window', async () => {
    const otherOrg = await makeOrg(env, 'globex');
    const foreign = await enrollDevice(env, otherOrg, 'emp');
    const victimSession = (await env.deps.pool.query(`SELECT id FROM work_sessions WHERE device_id = $1 LIMIT 1`, [dev.id])).rows[0].id;
    // A device can only speak for itself.
    const spoof = { ...bucket(foreign, victimSession, '2026-10-26T13:00:00.000Z'), device_id: dev.id, organization_id: dev.orgId };
    const r1 = await sendBatch(env, foreign, [spoof]);
    expect(r1.body.results[0]).toMatchObject({ status: 'rejected', reason: 'device_mismatch' });
    // A bucket for a session it doesn't own is unknown.
    const r2 = await sendBatch(env, foreign, [bucket(foreign, victimSession, '2026-10-26T13:00:00.000Z')]);
    expect(r2.body.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_session' });
  });

  it('stops collection for a revoked device', async () => {
    const d = await enrollDevice(env, org, 'emp2');
    const sid = randomUUID();
    await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, env.clock.iso())]);
    const rv = await org.admin.post(`/v1/admin/devices/${d.id}/revoke`);
    expect(rv.status).toBe(200);
    const res = await sendBatch(env, d, [bucket(d, sid, new Date(Math.floor(env.clock.t / 60_000) * 60_000).toISOString())]);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('device_revoked');
    const s = (await env.deps.pool.query('SELECT state, stop_reason FROM work_sessions WHERE id = $1', [sid])).rows[0];
    expect(s).toEqual({ state: 'stopped', stop_reason: 'revoked' });
  });

  it('serves a policy signed with the key returned at enrollment', async () => {
    const { createPublicKey, verify } = await import('node:crypto');
    const res = await deviceReq(env, dev, 'GET', `/v1/device/policy?project_id=${org.projectId}`);
    expect(res.status).toBe(200);
    const payload = Buffer.from(res.body.payload_b64, 'base64');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(dev.publicKeyB64, 'base64')]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, payload, key, Buffer.from(res.body.signature_b64, 'base64'))).toBe(true);
    const doc = JSON.parse(payload.toString());
    expect(doc).toMatchObject({ device_id: dev.id, project_id: org.projectId, user_id: dev.userId });
    expect(doc.settings.screenshots.enabled).toBe(false);
  });
});
