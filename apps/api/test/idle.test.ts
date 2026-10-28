import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
import {
  bucket,
  login,
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

/**
 * Stage 4 F1: the agent asks "you were away for N min — keep, remove or move?" and
 * reports the answer as idle.decision.v1.
 */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
});

const DAY = '2026-10-26';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

/** A 20-minute session from 09:00: minutes 05–11 are fully idle, minute 12 is half idle. */
function sessionEvents(d: Device, sid: string, opts: { skipMinute12?: boolean; projectId?: string } = {}) {
  const evs: object[] = [event(d, sid, 'session.started.v1', opts.projectId ? { project_id: opts.projectId } : {}, at('09:00'))];
  for (const m of minutes(at('09:00'), 20)) {
    const minute = new Date(m).getUTCMinutes();
    if (minute === 12 && opts.skipMinute12) continue;
    if (minute >= 5 && minute <= 11) evs.push(bucket(d, sid, m, 0, 60));
    else if (minute === 12) evs.push(bucket(d, sid, m, 30, 30));
    else evs.push(bucket(d, sid, m, 50, 10));
  }
  return evs;
}

function decision(d: Device, sid: string, decision: string, extra: object = {}) {
  return event(d, sid, 'idle.decision.v1', { idle_started_at: at('09:05'), idle_ended_at: '2026-10-26T09:12:30.000Z', decision, ...extra }, '2026-10-26T09:12:40.000Z');
}

async function sessionsOf(org: Org, who = 'emp') {
  const r = await org.users[who]!.client.get(`/v1/me/sessions?from=${DAY}T00:00:00Z&to=2026-10-27T00:00:00Z`);
  expect(r.status).toBe(200);
  return r.body.items as { id: string; source: string; project_id: string | null; tracked_seconds: number; idle_seconds: number; idle_adjustments: any[] }[];
}

function accepted(r: { body: { results: { status: string; reason?: string }[] } }) {
  return r.body.results.filter((x) => x.status !== 'accepted');
}

describe('idle return decisions', () => {
  it('removes the idle seconds of the span, and keeps them removed when the last bucket arrives later', async () => {
    const org = await makeOrg(env, 'idle1');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    env.clock.t = new Date('2026-10-26T10:00:00Z').getTime();
    // The answer is sent before the minute of the return (09:12) has closed.
    const evs = sessionEvents(d, sid, { skipMinute12: true });
    const answer = decision(d, sid, 'discard'); // after the session's events, in device order
    const first = await sendBatch(env, d, [...evs, answer]);
    expect(accepted(first)).toEqual([]);
    await env.drain();
    const late = await sendBatch(env, d, [bucket(d, sid, at('09:12'), 30, 30)]);
    expect(accepted(late)).toEqual([]);
    await env.drain();

    const [s] = await sessionsOf(org);
    // 12 normal minutes × 60 s + minute 12's active 30 s; all of minutes 05–12's idle is gone.
    expect(s!.idle_seconds).toBe(12 * 10);
    expect(s!.tracked_seconds).toBe(12 * 60 + 30);
    expect(s!.idle_adjustments).toEqual([
      expect.objectContaining({ decision: 'discard', status: 'applied', seconds: 450, idle_started_at: expect.any(String) }),
    ]);
    // A replayed event (offline resend) is a duplicate and changes nothing.
    const replay = await sendBatch(env, d, [answer]);
    expect(replay.body.results[0].status).toBe('duplicate');
    await env.drain();
    expect((await sessionsOf(org))[0]!.idle_adjustments).toHaveLength(1);
  });

  it('keeps each organisation\u2019s idle decisions to itself (row-level security)', async () => {
    const a = await makeOrg(env, 'idlerls');
    const b = await makeOrg(env, 'idlerls2');
    const d = await enrollDevice(env, a, 'emp');
    const sid = randomUUID();
    const evs = sessionEvents(d, sid);
    await sendBatch(env, d, [...evs, decision(d, sid, 'discard')]);
    await env.drain();
    const mine = await withScope(a.id, () => env.deps.pool.query('SELECT count(*)::int AS n FROM idle_decisions'));
    const theirs = await withScope(b.id, () => env.deps.pool.query('SELECT count(*)::int AS n FROM idle_decisions'));
    expect(mine.rows[0].n).toBe(1);
    expect(theirs.rows[0].n).toBe(0);
  });

  it('an edge minute loses only the span\u2019s part of its idle seconds', async () => {
    const org = await makeOrg(env, 'idleedge');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    env.clock.t = new Date('2026-10-26T10:00:00Z').getTime();
    const evs = sessionEvents(d, sid);
    // The run began 20 s into minute 05; that minute's first 20 idle seconds belong to an earlier run.
    const answer = event(d, sid, 'idle.decision.v1', { idle_started_at: '2026-10-26T09:05:20.000Z', idle_ended_at: '2026-10-26T09:12:30.000Z', decision: 'discard' }, '2026-10-26T09:12:40.000Z');
    await sendBatch(env, d, [...evs, answer]);
    await env.drain();
    // Re-sending a bucket of the span (offline replay) must not double-subtract or restore it.
    await sendBatch(env, d, [bucket(d, sid, at('09:05'), 0, 60), bucket(d, sid, at('09:12'), 30, 30)]);
    await env.drain();
    const [s] = await sessionsOf(org);
    expect(s!.idle_seconds).toBe(12 * 10 + 20);
    expect(s!.tracked_seconds).toBe(12 * 60 + 30 + 20);
  });

  it('keep changes nothing and is not listed', async () => {
    const org = await makeOrg(env, 'idle2');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [...sessionEvents(d, sid), decision(d, sid, 'keep')]);
    await env.drain();
    const [s] = await sessionsOf(org);
    expect(s!.tracked_seconds).toBe(20 * 60);
    expect(s!.idle_adjustments).toEqual([]);
  });

  it('moving the span is a correction: pending until the manager decides', async () => {
    const org = await makeOrg(env, 'idle3', 'standard');
    const other = await org.admin.post('/v1/admin/projects', { name: 'Internal meetings' });
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [...sessionEvents(d, sid, { projectId: org.projectId }), decision(d, sid, 'reassign', { project_id: other.body.id })]);
    await env.drain();

    let list = await sessionsOf(org);
    expect(list).toHaveLength(1);
    expect(list[0]!.tracked_seconds).toBe(20 * 60);
    expect(list[0]!.idle_adjustments[0]).toMatchObject({ decision: 'reassign', status: 'pending', project_name: 'Internal meetings' });

    const pending = await org.users.manager!.client.get('/v1/corrections/pending');
    const c = pending.body.items.find((x: { kind: string }) => x.kind === 'idle_reassign');
    expect(c).toMatchObject({ user_id: org.users.emp!.id, requested: { project_id: other.body.id }, original: { project_id: org.projectId } });
    // Named for a reviewer who doesn't manage the target project.
    expect(c.project_names).toEqual({ [other.body.id]: 'Internal meetings', [org.projectId]: 'idle3 Project' });
    expect((await org.users.manager!.client.post(`/v1/corrections/${c.id}/approve`, {})).status).toBe(200);

    list = await sessionsOf(org);
    const agent = list.find((s) => s.source === 'agent')!;
    const manual = list.find((s) => s.source === 'manual')!;
    expect(agent.idle_adjustments[0]).toMatchObject({ status: 'applied' });
    expect(agent.tracked_seconds).toBe(12 * 60 + 30);
    expect(manual).toMatchObject({ project_id: other.body.id, tracked_seconds: 450 });
  });

  it('a rejected move leaves the time where it was', async () => {
    const org = await makeOrg(env, 'idle4', 'standard');
    const other = await org.admin.post('/v1/admin/projects', { name: 'Elsewhere' });
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [...sessionEvents(d, sid), decision(d, sid, 'reassign', { project_id: other.body.id })]);
    await env.drain();
    const c = (await org.users.manager!.client.get('/v1/corrections/pending')).body.items[0];
    expect((await org.users.manager!.client.post(`/v1/corrections/${c.id}/reject`, { note: 'Was the stand-up' })).status).toBe(200);
    const [s] = await sessionsOf(org);
    expect(s!.tracked_seconds).toBe(20 * 60);
    expect(s!.idle_adjustments[0]).toMatchObject({ status: 'rejected' });
  });

  it('on plans without approvals a move applies at once', async () => {
    const org = await makeOrg(env, 'idle5', 'free');
    const other = await org.admin.post('/v1/admin/projects', { name: 'Calls' });
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [...sessionEvents(d, sid), decision(d, sid, 'reassign', { project_id: other.body.id })]);
    await env.drain();
    const list = await sessionsOf(org);
    expect(list.map((s) => s.tracked_seconds).sort((a, b) => a - b)).toEqual([450, 12 * 60 + 30]);
  });

  it('cannot change a week that is approved and locked', async () => {
    const org = await makeOrg(env, 'idle6');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    env.clock.t = new Date('2026-11-02T10:00:00Z').getTime();
    await sendBatch(env, d, sessionEvents(d, sid));
    await env.drain();
    // Moving the clock a week ends the sign-in sessions: sign in again.
    for (const who of ['emp', 'manager']) org.users[who]!.client = await login(env.app, `${who}@idle6.test`);
    const ts = await org.users.emp!.client.post('/v1/me/timesheets/2026-10-26/submit', {});
    expect(ts.status).toBe(200);
    expect((await org.users.manager!.client.post(`/v1/timesheets/${ts.body.id}/approve`, {})).status).toBe(200);

    await sendBatch(env, d, [decision(d, sid, 'discard')]);
    await env.drain();
    const [s] = await sessionsOf(org);
    expect(s!.tracked_seconds).toBe(20 * 60);
    expect(s!.idle_adjustments[0]).toMatchObject({ status: 'rejected', status_reason: 'week_locked' });
  });

  it('rejects malformed answers and spans outside the session', async () => {
    const org = await makeOrg(env, 'idle7');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    env.clock.t = new Date('2026-10-26T10:00:00Z').getTime();
    await sendBatch(env, d, sessionEvents(d, sid));
    const r = await sendBatch(env, d, [
      decision(d, sid, 'reassign'),
      decision(d, sid, 'discard', { project_id: org.projectId }),
      decision(d, sid, 'discard', { task_id: randomUUID() }),
      decision(d, sid, 'reassign', { project_id: null }),
      event(d, sid, 'idle.decision.v1', { idle_started_at: at('09:12'), idle_ended_at: at('09:05'), decision: 'discard' }, at('09:13')),
      event(d, sid, 'idle.decision.v1', { idle_started_at: at('07:00'), idle_ended_at: at('07:30'), decision: 'discard' }, at('09:13')),
    ]);
    expect(r.body.results.map((x: { status: string; reason?: string }) => x.reason?.split(':')[0])).toEqual([
      'invalid_event', 'invalid_event', 'invalid_event', 'invalid_event', 'invalid_event', 'outside_session_window',
    ]);
  });
});
