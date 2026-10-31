import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Stage 4 F8: bonuses, deductions and reimbursements in the payroll file. */

let env: TestEnv;
let org: Org;

const add = (body: Record<string, unknown>) =>
  org.admin.post('/v1/admin/payroll-adjustments', { user_id: org.users.emp!.id, currency: 'USD', recurrence: 'once', note: 'Q3 bonus', ...body });

async function payroll(from: string, to: string): Promise<Record<string, string>[]> {
  const ex = await org.admin.post('/v1/admin/payroll-exports', { period_from: from, period_to: to, timezone: 'UTC' });
  await env.drain();
  const [header, ...rows] = env.store.objects.get(`payroll/${org.id}/${ex.body.id}.csv`)!.body.toString().trim().split(/\r?\n/);
  const cols = header!.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-10-26T13:00:00Z').getTime();
  org = await makeOrg(env, 'adj');
});

describe('payroll adjustments', () => {
  it('fall in the period they belong to, as their own columns', async () => {
    expect((await add({ kind: 'bonus', amount_cents: 50_000, effective_from: '2026-10-15' })).status).toBe(201);
    const ded = await add({ kind: 'deduction', amount_cents: 5_000, recurrence: 'every_period', effective_from: '2026-09-01', note: 'Parking' });
    expect(ded.status).toBe(201);
    await add({ kind: 'reimbursement', amount_cents: 2_500, effective_from: '2026-11-05', note: 'Phone' });
    expect((await add({ kind: 'bonus', amount_cents: 1, effective_from: '2026-10-01', effective_to: '2026-10-31' })).status).toBe(400);

    const oct = (await payroll('2026-10-01', '2026-10-31')).find((r) => r.email === 'emp@adj.test')!;
    expect(oct).toMatchObject({ currency: 'USD', bonus: '500.00', deductions: '50.00', reimbursements: '0.00' });
    const nov = (await payroll('2026-11-01', '2026-11-30')).find((r) => r.email === 'emp@adj.test')!;
    expect(nov).toMatchObject({ bonus: '0.00', deductions: '50.00', reimbursements: '25.00' });

    // Ending the recurring one stops it after that day.
    await org.admin.post(`/v1/admin/payroll-adjustments/${ded.body.id}/end`, { effective_to: '2026-10-31' });
    const nov2 = (await payroll('2026-11-01', '2026-11-30')).find((r) => r.email === 'emp@adj.test')!;
    expect(nov2.deductions).toBe('0.00');
  });

  it('the person sees their own; amounts stay out of the audit log', async () => {
    const mine = (await org.users.emp!.client.get('/v1/me/payroll-adjustments')).body.items;
    expect(mine.map((a: { kind: string }) => a.kind).sort()).toEqual(['bonus', 'deduction', 'reimbursement']);
    expect((await org.users.emp2!.client.get('/v1/me/payroll-adjustments')).body.items).toEqual([]);
    expect((await org.users.manager!.client.get('/v1/admin/payroll-adjustments')).status).toBe(403);
    const rows = await withScope(SYSTEM_SCOPE, () =>
      env.deps.pool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'payroll_adjustment.%'`, [org.id]),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toMatch(/50000|5000|2500/);
  });

  it('one-time adjustments are deleted, recurring ones ended', async () => {
    const [once] = (await org.admin.get(`/v1/admin/payroll-adjustments?user_id=${org.users.emp!.id}`)).body.items.filter((a: { kind: string }) => a.kind === 'bonus');
    expect((await org.admin.post(`/v1/admin/payroll-adjustments/${once.id}/end`, { effective_to: '2026-12-31' })).body.error.code).toBe('not_recurring');
    expect((await org.admin.req('DELETE', `/v1/admin/payroll-adjustments/${once.id}`)).status).toBe(200);
    expect((await org.users.emp!.client.get('/v1/me/payroll-adjustments')).body.items).toHaveLength(2);
  });

  it("an admin's view shows in the person's access log", async () => {
    await org.admin.get('/v1/admin/payroll-adjustments');
    const log = (await org.users.emp!.client.get('/v1/me/access-log')).body.items.map((x: { action: string }) => x.action);
    expect(log).toContain('payroll_adjustment.view');
  });
});
