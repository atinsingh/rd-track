import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Stage 4 F2: approve or send back many requests in one call, each checked on its own. */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-02T10:00:00Z').getTime();
});

const manual = (day: string, note = 'Forgot the timer') => ({
  requested: { started_at: `${day}T08:00:00Z`, ended_at: `${day}T08:30:00Z`, project_id: null },
  reason: note,
});

async function setup(prefix: string, plan: 'free' | 'standard' | 'pro' = 'pro') {
  const org = await makeOrg(env, prefix, plan);
  const c = (k: string) => org.users[k]!.client;
  const emp = await c('emp').post('/v1/me/time-corrections', manual('2026-10-27'));
  const emp2 = org.users.emp2 ? await c('emp2').post('/v1/me/time-corrections', manual('2026-10-28')) : null; // Free has two people
  const own = await c('manager').post('/v1/me/time-corrections', manual('2026-10-29', 'My own'));
  return { org, c, ids: { emp: emp.body.id as string, emp2: emp2?.body.id as string, own: own.body.id as string } };
}

async function submitWeek(org: Org, who: string) {
  const d = await enrollDevice(env, org, who);
  const sid = randomUUID();
  await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, '2026-10-27T09:00:00Z'), ...minutes('2026-10-27T09:00:00Z', 30).map((m) => bucket(d, sid, m))]);
  await env.drain();
  const r = await org.users[who]!.client.post('/v1/me/timesheets/2026-10-26/submit', {});
  expect(r.status).toBe(200);
  return r.body.id as string;
}

describe('batch approvals', () => {
  it('approves what the reviewer may approve and reports the rest per item', async () => {
    const { org, c, ids } = await setup('batch1');
    const ts = await submitWeek(org, 'emp');
    const r = await c('manager').post('/v1/approvals/batch', {
      action: 'approve',
      items: [
        { type: 'correction', id: ids.emp },
        { type: 'correction', id: ids.emp2 },
        { type: 'correction', id: ids.own },
        { type: 'timesheet', id: ts },
        { type: 'correction', id: randomUUID() },
        { type: 'correction', id: ids.emp }, // duplicate in the same call: reviewed once
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approved: 3, rejected: 0, failed: 2 });
    expect(r.body.results.map((x: { ok: boolean; code?: string }) => x.code ?? 'ok')).toEqual(['ok', 'ok', 'forbidden', 'ok', 'not_found']);
    const mine = await c('emp').get('/v1/me/corrections');
    expect(mine.body.items[0].status).toBe('approved');
    // Approving again is a per-item conflict, not a failed request.
    const again = await c('manager').post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'correction', id: ids.emp }] });
    expect(again.body.results[0]).toMatchObject({ ok: false, code: 'already_reviewed' });
  });

  it('needs a note to send back, and applies it to every item', async () => {
    const { c, ids } = await setup('batch2');
    const bad = await c('manager').post('/v1/approvals/batch', { action: 'reject', items: [{ type: 'correction', id: ids.emp }] });
    expect(bad.status).toBe(400);
    const r = await c('manager').post('/v1/approvals/batch', {
      action: 'reject',
      note: 'Please add which client this was for',
      items: [{ type: 'correction', id: ids.emp }, { type: 'correction', id: ids.emp2 }],
    });
    expect(r.body).toMatchObject({ approved: 0, rejected: 2, failed: 0 });
    const mine = await c('emp2').get('/v1/me/corrections');
    expect(mine.body.items[0]).toMatchObject({ status: 'rejected', review_note: 'Please add which client this was for' });
  });

  it('time off goes through the same rules', async () => {
    const { org, c } = await setup('batch3');
    const p = await org.admin.post('/v1/admin/time-off/policies', { name: 'Vacation', kind: 'paid' });
    await org.admin.post('/v1/admin/time-off/assignments', { policy_id: p.body.id, user_id: org.users.emp!.id, start_date: '2026-01-01', opening_balance_hours: 40 });
    const req = await c('emp').post('/v1/me/time-off/requests', { policy_id: p.body.id, start_date: '2026-11-13', end_date: '2026-11-13' });
    expect(req.status).toBe(201);
    const r = await c('manager').post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'time_off', id: req.body.id }] });
    expect(r.body).toMatchObject({ approved: 1, failed: 0 });
    // An employee can't approve anyone's request.
    const denied = await c('emp').post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'time_off', id: req.body.id }] });
    expect(denied.body.results[0].ok).toBe(false);
  });

  it('reports plan gates per item instead of failing the call', async () => {
    const { c, ids } = await setup('batch4', 'free');
    const r = await c('manager').post('/v1/approvals/batch', {
      action: 'approve',
      items: [{ type: 'timesheet', id: randomUUID() }, { type: 'time_off', id: randomUUID() }, { type: 'correction', id: ids.emp }],
    });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { code?: string }) => x.code ?? 'ok')).toEqual(['plan_upgrade_required', 'plan_upgrade_required', 'already_reviewed']);
  });

  it('keeps each tenant to itself', async () => {
    const a = await setup('batch5');
    const b = await setup('batch6');
    const r = await b.c('manager').post('/v1/approvals/batch', { action: 'approve', items: [{ type: 'correction', id: a.ids.emp }] });
    expect(r.body.results[0]).toMatchObject({ ok: false, code: 'not_found' });
  });
});
