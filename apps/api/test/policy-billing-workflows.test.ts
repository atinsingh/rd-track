import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/lib/crypto';
import { runRetention } from '../src/modules/retention/service';
import {
  bucket,
  deviceReq,
  enrollDevice,
  event,
  login,
  makeOrg,
  minutes,
  sendBatch,
  testEnv,
  type Org,
  type TestEnv,
} from './helpers';

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
});

describe('policy publishing', () => {
  let org: Org;
  beforeAll(async () => {
    org = await makeOrg(env, 'pol');
  });

  it('requires explicit confirmation when collection expands, then notifies employees (POL-05)', async () => {
    const body = { settings: { screenshots: { enabled: true } }, change_note: 'Contract requirement' };
    const first = await org.admin.put(`/v1/policies/team/${org.teamId}`, body);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('expansion_requires_confirmation');
    expect(first.body.error.details.affected_users).toBe(3);
    expect(first.body.error.details.changes.map((c: { field: string }) => c.field)).toContain('screenshots.enabled');

    const ok = await org.admin.put(`/v1/policies/team/${org.teamId}`, { ...body, confirm_expansion: true });
    expect(ok.status).toBe(200);
    expect(ok.body.effective.settings.screenshots.enabled).toBe(true);
    expect(ok.body.scope.current.expands_collection).toBe(true);

    const notes = await org.users.emp!.client.get('/v1/me/notifications');
    expect(notes.body.items[0].kind).toBe('policy_expansion');
    const mine = await org.users.emp!.client.get('/v1/me/policy');
    expect(mine.body.base.settings.screenshots.enabled).toBe(true);
    expect(mine.body.base.sources['screenshots.enabled'][0].scope_type).toBe('team');
  });

  it('publishes restrictions without confirmation, and an org-level Off vetoes the team On', async () => {
    const r = await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: { screenshots: { enabled: false } },
      change_note: 'Pause screenshots company-wide',
    });
    expect(r.status).toBe(200);
    const mine = await org.users.emp!.client.get('/v1/me/policy');
    expect(mine.body.base.settings.screenshots.enabled).toBe(false);
    const list = await org.admin.get('/v1/policies');
    expect(list.body.org_revision).toBe(2);
  });

  it('only admins publish policies, and not into another tenant', async () => {
    const other = await makeOrg(env, 'pol2');
    expect((await org.users.manager!.client.put(`/v1/policies/team/${org.teamId}`, { settings: {}, change_note: 'nope' })).status).toBe(403);
    expect((await other.admin.put(`/v1/policies/team/${org.teamId}`, { settings: {}, change_note: 'nope' })).status).toBe(404);
  });
});

describe('licensing and plans', () => {
  it('Free allows two tracked users; a third needs a paid plan', async () => {
    const org = await makeOrg(env, 'free1', 'free');
    const r = await org.admin.post('/v1/admin/users', { email: 'third@free1.test', display_name: 'Third', password: 'correct-horse-battery' });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('plan_upgrade_required');
    // Viewer seats are free and unlimited.
    const viewer = await org.admin.post('/v1/admin/users', { email: 'viewer@free1.test', display_name: 'Viewer', tracking_enabled: false, password: 'correct-horse-battery' });
    expect(viewer.status).toBe(201);
    const sub = await org.admin.get('/v1/billing/subscription');
    expect(sub.body).toMatchObject({ plan: 'free', billable_seats: 2, viewer_seats: 2, estimated_monthly_cents: 0 });
  });

  it('paid plans allow a small overage, then refuse with seat_limit_reached', async () => {
    const org = await makeOrg(env, 'std', 'standard', 1); // 3 tracked already; ceiling = 1 + 2
    const r = await org.admin.post('/v1/admin/users', { email: 'x@std.test', display_name: 'X', password: 'correct-horse-battery' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('seat_limit_reached');
    const up = await org.admin.post('/v1/billing/plan', { plan: 'standard', seats: 5 });
    expect(up.status).toBe(200);
    expect(up.body.subscription.estimated_monthly_cents).toBe(5 * 250);
    expect(up.body.checkout_url).toBeNull();
    expect((await org.admin.post('/v1/admin/users', { email: 'x@std.test', display_name: 'X', password: 'correct-horse-battery' })).status).toBe(201);
  });

  it('Standard cannot enable screenshots or scoped policies', async () => {
    const org = await makeOrg(env, 'std2', 'standard', 5);
    const scoped = await org.admin.put(`/v1/policies/team/${org.teamId}`, { settings: {}, change_note: 'team policy' });
    expect(scoped.status).toBe(402);
    const shots = await org.admin.put(`/v1/policies/organization/${org.id}`, { settings: { screenshots: { enabled: true } }, change_note: 'Enable screenshots', confirm_expansion: true });
    expect(shots.status).toBe(402);
    const detail = await org.admin.get(`/v1/policies/organization/${org.id}`);
    expect(detail.body.plan_locked_fields).toContain('screenshots.enabled');
  });

  it('an inactive subscription stops agents visibly', async () => {
    const org = await makeOrg(env, 'lapsed', 'pro', 5);
    const dev = await enrollDevice(env, org, 'emp');
    await env.deps.pool.query(`UPDATE subscriptions SET status = 'inactive' WHERE organization_id = $1`, [org.id]);
    const hb = await deviceReq(env, dev, 'POST', '/v1/device/heartbeat', {
      agent_version: '0.1.0',
      client_time: env.clock.iso(),
      permissions: { input_monitoring: 'granted', screen_recording: 'granted', accessibility: 'not_required' },
      outbox_depth: 0,
      applied_policy_revision: null,
    });
    expect(hb.status).toBe(403);
    expect(hb.body.error.code).toBe('subscription_inactive');
    const batch = await sendBatch(env, dev, [event(dev, randomUUID(), 'session.started.v1', {}, env.clock.iso())]);
    expect(batch.body.error.code).toBe('subscription_inactive');
  });

  it('heartbeat reports licence state and records the applied policy revision', async () => {
    const org = await makeOrg(env, 'hb', 'pro', 5);
    const dev = await enrollDevice(env, org, 'emp');
    const hb = await deviceReq(env, dev, 'POST', '/v1/device/heartbeat', {
      agent_version: '0.1.1',
      client_time: env.clock.iso(-300_000),
      permissions: { input_monitoring: 'granted', screen_recording: 'denied', accessibility: 'not_required' },
      outbox_depth: 3,
      applied_policy_revision: 0,
    });
    expect(hb.status).toBe(200);
    expect(hb.body.license).toEqual({ status: 'active' });
    const devices = await org.admin.get('/v1/admin/devices');
    expect(devices.body.items[0]).toMatchObject({ agent_version: '0.1.1', clock_skew_detected: true, applied_policy_revision: 0 });
  });
});

describe('corrections, exports and retention', () => {
  let org: Org;
  beforeAll(async () => {
    org = await makeOrg(env, 'wf');
  });

  it('keeps the original when a manager approves a correction (TIME-08)', async () => {
    const dev = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    const start = '2026-10-26T13:00:00.000Z';
    env.clock.t = new Date('2026-10-26T13:31:00Z').getTime();
    await sendBatch(env, dev, [
      event(dev, sid, 'session.started.v1', {}, start),
      ...minutes(start, 30).map((m) => bucket(dev, sid, m)),
      event(dev, sid, 'session.stopped.v1', { reason: 'user' }, '2026-10-26T13:30:00Z'),
    ]);
    await env.drain();
    const proposal = await org.users.emp!.client.post('/v1/me/time-corrections', {
      session_id: sid,
      requested: { started_at: '2026-10-26T12:45:00Z', ended_at: '2026-10-26T13:30:00Z', project_id: org.projectId },
      reason: 'Forgot to start the timer before stand-up',
    });
    expect(proposal.status).toBe(201);
    expect(proposal.body.status).toBe('pending');
    expect((await org.users.emp2!.client.post(`/v1/corrections/${proposal.body.id}/approve`)).status).toBe(403);

    const pending = await org.users.manager!.client.get('/v1/corrections/pending');
    expect(pending.body.items.map((c: { id: string }) => c.id)).toContain(proposal.body.id);
    const approved = await org.users.manager!.client.post(`/v1/corrections/${proposal.body.id}/approve`, { note: 'OK' });
    expect(approved.status).toBe(200);
    expect(approved.body.original.started_at).toBe('2026-10-26T13:00:00.000Z');
    const s = (await env.deps.pool.query('SELECT started_at, corrected FROM work_sessions WHERE id = $1', [sid])).rows[0];
    expect(s).toEqual({ started_at: '2026-10-26T12:45:00.000Z', corrected: true });
    await expect(env.deps.pool.query(`UPDATE time_corrections SET original = '{}' WHERE id = $1`, [proposal.body.id])).rejects.toThrow(/immutable/);
  });

  it('exports CSV with formula-injection protection and an expiring link (RPT-04)', async () => {
    await env.deps.pool.query(`UPDATE projects SET name = '=HYPERLINK("http://evil")' WHERE id = $1`, [org.projectId]);
    const r = await org.users.manager!.client.post('/v1/exports', {
      kind: 'sessions',
      from: '2026-10-26T00:00:00Z',
      to: '2026-10-27T00:00:00Z',
      team_id: org.teamId,
    });
    expect(r.status).toBe(201);
    await env.drain();
    const ready = await org.users.manager!.client.get(`/v1/exports/${r.body.id}`);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.download_url).toMatch(/^memory:/);
    const key = (await env.deps.pool.query('SELECT object_key FROM export_jobs WHERE id = $1', [r.body.id])).rows[0].object_key;
    const csv = (await env.store.get(key))!.toString();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    // Another employee can't fetch someone else's export.
    expect((await org.users.emp!.client.get(`/v1/exports/${r.body.id}`)).status).toBe(404);
  });

  it('retention deletes expired screenshots unless under legal hold (AUD-03/04)', async () => {
    const dev = (await env.deps.pool.query(`SELECT id FROM devices WHERE organization_id = $1 LIMIT 1`, [org.id])).rows[0].id;
    const sid = (await env.deps.pool.query(`SELECT id FROM work_sessions WHERE organization_id = $1 LIMIT 1`, [org.id])).rows[0].id;
    const mk = async (userId: string) => {
      const id = randomUUID();
      const key = `screenshots/${org.id}/${id}.webp`;
      await env.store.put(key, Buffer.from('x'), 'image/webp');
      await env.deps.pool.query(
        `INSERT INTO screenshots (id, organization_id, session_id, user_id, device_id, object_key, content_type, status, captured_at,
           policy_revision, intent_expires_at, retention_after)
         VALUES ($1, $2, $3, $4, $5, $6, 'image/webp', 'stored', '2026-09-01T10:00:00Z', 1, '2026-09-01T10:05:00Z', '2026-10-01T10:00:00Z')`,
        [id, org.id, sid, userId, dev, key],
      );
      return { id, key };
    };
    const expired = await mk(org.users.emp!.id);
    const held = await mk(org.users.emp!.id);
    await env.deps.pool.query(`UPDATE screenshots SET user_id = $2 WHERE id = $1`, [held.id, org.users.emp2!.id]);
    const hold = await org.admin.post('/v1/admin/legal-holds', {
      user_id: org.users.emp2!.id,
      from: '2026-08-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z',
      reason: 'Litigation hold, matter 2026-17',
    });
    expect(hold.status).toBe(201);
    await runRetention(env.deps);
    expect(await env.store.head(expired.key)).toBeNull();
    expect(await env.store.head(held.key)).not.toBeNull();
  });
});

describe('multi-factor authentication', () => {
  it('blocks admin routes until TOTP is enrolled and verified', async () => {
    const strict = await import('./helpers').then((h) => h.testEnv({ mfaRequiredForAdmins: true }));
    try {
      const { createOrganization } = await import('../src/modules/platform/routes');
      const { hashPassword } = await import('../src/lib/crypto');
      const created = await createOrganization(
        strict.deps,
        strict.deps.pool,
        { name: 'MFA Inc', slug: 'mfa', region: 'ca-central-1', admin_email: 'admin@mfa.test', admin_name: 'Admin', plan: 'pro', seats: 5 },
        { kind: 'system' },
      );
      await strict.deps.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [created.admin_user_id, await hashPassword('correct-horse-battery')]);
      const org = { admin: await login(strict.app, 'admin@mfa.test') };
      const blocked = await org.admin.get('/v1/admin/users');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('mfa_required');
      const me = await org.admin.get('/v1/me');
      expect(me.body.mfa_verified).toBe(false);
      const enroll = await org.admin.post('/v1/auth/mfa/enroll');
      const bad = await org.admin.post('/v1/auth/mfa/enroll/confirm', { code: '000000' });
      expect(bad.status).toBe(400);
      const good = await org.admin.post('/v1/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret_base32, strict.clock.t) });
      expect(good.status).toBe(200);
      expect((await org.admin.get('/v1/admin/users')).status).toBe(200);
      // A new sign-in needs the code again.
      const again = await login(strict.app, 'admin@mfa.test');
      expect((await again.get('/v1/admin/users')).status).toBe(403);
      expect((await again.post('/v1/auth/mfa/verify', { code: totp(enroll.body.secret_base32, strict.clock.t) })).status).toBe(200);
      expect((await again.get('/v1/admin/users')).status).toBe(200);
    } finally {
      await strict.close();
    }
  });
});
