import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBillingLifecycle } from '../src/modules/billing/service';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { deviceReq, enrollDevice, login, makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Engine slice 1: domain events fan out to one notification service (in-app now, email by job). */

let env: TestEnv;
afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-02T10:00:00Z').getTime();
});

const manual = (day: string) => ({
  requested: { started_at: `${day}T08:00:00Z`, ended_at: `${day}T08:30:00Z`, project_id: null },
  reason: 'Forgot the timer',
});
const inbox = async (org: Org, who: string) => (await (who === 'admin' ? org.admin : org.users[who]!.client).get('/v1/me/notifications')).body;
const mailTo = (email: string) => env.email.sent.filter((m) => m.to === email);

describe('notifications from domain events', () => {
  it('a correction reaches the manager in-app and by email, and the decision reaches the employee', async () => {
    const org = await makeOrg(env, 'eng1', 'standard');
    const c = await org.users.emp!.client.post('/v1/me/time-corrections', manual('2026-10-27'));
    expect(c.status).toBe(201);

    const mgr = await inbox(org, 'manager');
    expect(mgr.unread).toBe(1);
    expect(mgr.items[0]).toMatchObject({ kind: 'correction_review', category: 'approvals', title: 'eng1 emp asked to correct their time', link: '/approvals', read_at: null });
    // Email goes out from the worker, once, with a link and no reason text.
    expect(mailTo('manager@eng1.test')).toHaveLength(0);
    await env.drain();
    await env.drain();
    const mail = mailTo('manager@eng1.test');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain('/approvals');
    expect(mail[0]!.text).not.toContain('Forgot the timer');
    expect(mail[0]!.html).toContain('Open in Track');

    await org.users.manager!.client.post(`/v1/corrections/${c.body.id}/reject`, { note: 'Which client?' });
    const emp = await inbox(org, 'emp');
    expect(emp.items[0]).toMatchObject({ kind: 'correction_decision', category: 'my_requests', title: 'Your time correction was sent back', link: '/me/time' });
    expect(emp.items[0].body).toContain('Which client?');
    // The manager's own notification isn't repeated to them.
    expect((await inbox(org, 'manager')).items).toHaveLength(1);
  });

  it('someone with no team manager is reviewed by the org admins, so nothing waits on nobody', async () => {
    const org = await makeOrg(env, 'eng2', 'standard');
    const loner = await org.admin.post('/v1/admin/users', { email: 'loner@eng2.test', display_name: 'Loner', password: 'correct-horse-battery' });
    expect(loner.status).toBe(201);
    const client = await login(env.app, 'loner@eng2.test');
    expect((await client.post('/v1/me/time-corrections', manual('2026-10-28'))).status).toBe(201);
    const admin = await inbox(org, 'admin');
    expect(admin.items.map((n: { kind: string }) => n.kind)).toContain('correction_review');
    expect((await inbox(org, 'manager')).items).toHaveLength(0);
  });

  it('respects preferences, but never mutes the mandatory categories', async () => {
    const org = await makeOrg(env, 'eng3', 'standard');
    const emp = org.users.emp!.client;
    const prefs = await emp.get('/v1/me/notification-preferences');
    expect(prefs.body.items.find((p: { category: string }) => p.category === 'privacy')).toEqual({ category: 'privacy', in_app: true, email: true, mandatory: true });

    const put = await emp.req('PUT', '/v1/me/notification-preferences', {
      items: [
        { category: 'my_requests', in_app: true, email: false },
        { category: 'privacy', in_app: false, email: false },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.items.find((p: { category: string }) => p.category === 'my_requests')).toMatchObject({ in_app: true, email: false });
    expect(put.body.items.find((p: { category: string }) => p.category === 'privacy')).toMatchObject({ in_app: true, email: true });

    const c = await emp.post('/v1/me/time-corrections', manual('2026-10-29'));
    await org.users.manager!.client.post(`/v1/corrections/${c.body.id}/approve`, {});
    await env.drain();
    expect((await inbox(org, 'emp')).items[0]).toMatchObject({ kind: 'correction_decision' });
    expect(mailTo('emp@eng3.test')).toHaveLength(0);

    // Off for both: nothing is written at all.
    await emp.req('PUT', '/v1/me/notification-preferences', { items: [{ category: 'my_requests', in_app: false, email: false }] });
    const c2 = await emp.post('/v1/me/time-corrections', manual('2026-10-30'));
    await org.users.manager!.client.post(`/v1/corrections/${c2.body.id}/approve`, {});
    expect((await inbox(org, 'emp')).items).toHaveLength(1);
  });

  it('marks read one at a time or all at once, and counts unread', async () => {
    const org = await makeOrg(env, 'eng4', 'standard');
    for (const d of ['2026-10-26', '2026-10-27', '2026-10-28']) await org.users.emp!.client.post('/v1/me/time-corrections', manual(d));
    const mgr = org.users.manager!.client;
    expect((await mgr.get('/v1/me/notifications/unread-count')).body).toEqual({ unread: 3 });
    const [first, second] = (await mgr.get('/v1/me/notifications')).body.items;
    await mgr.post(`/v1/me/notifications/${first.id}/read`);
    // Someone else marking it changes nothing.
    await org.users.emp!.client.post(`/v1/me/notifications/${second.id}/read`);
    expect((await mgr.get('/v1/me/notifications?unread=1')).body.items.map((n: { id: string }) => n.id)).toContain(second.id);
    expect((await mgr.get('/v1/me/notifications?unread=1')).body.items).toHaveLength(2);
    expect((await mgr.post('/v1/me/notifications/read-all')).body).toEqual({ marked: 2 });
    expect((await mgr.get('/v1/me/notifications/unread-count')).body).toEqual({ unread: 0 });
  });

  it('a submitted timesheet reaches the reviewer', async () => {
    const org = await makeOrg(env, 'eng5', 'standard');
    expect((await org.users.emp!.client.post('/v1/me/timesheets/2026-10-26/submit', {})).status).toBe(200);
    expect((await inbox(org, 'manager')).items[0]).toMatchObject({ kind: 'timesheet_submitted', title: 'eng5 emp submitted their timesheet', link: '/approvals' });
  });

  it('tells people about their computers: disconnected, or missing a permission (once a day)', async () => {
    const org = await makeOrg(env, 'eng6');
    const d = await enrollDevice(env, org, 'emp');
    const beat = (screen: string) =>
      deviceReq(env, d, 'POST', '/v1/device/heartbeat', {
        agent_version: '0.1.0',
        client_time: env.clock.iso(),
        permissions: { input_monitoring: 'granted', screen_recording: screen, accessibility: 'not_required' },
        outbox_depth: 0,
        applied_policy_revision: null,
      });
    expect((await beat('granted')).status).toBe(200);
    expect((await beat('denied')).status).toBe(200);
    expect((await beat('denied')).status).toBe(200);
    expect((await beat('granted')).status).toBe(200);
    expect((await beat('denied')).status).toBe(200); // same day: not repeated
    let items = (await inbox(org, 'emp')).items.filter((n: { kind: string }) => n.kind === 'device_permission');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Test laptop needs a permission', category: 'devices' });
    expect(items[0].body).toContain('Screen Recording');

    await org.admin.post(`/v1/admin/devices/${d.id}/revoke`, {});
    items = (await inbox(org, 'emp')).items.filter((n: { kind: string }) => n.kind === 'device_revoked');
    expect(items[0]).toMatchObject({ title: 'Test laptop was disconnected from Track' });
  });

  it('escapes names in email HTML', async () => {
    const org = await makeOrg(env, 'eng7', 'standard');
    await env.deps.pool.query(`UPDATE users SET display_name = '<script>x</script>' WHERE id = $1`, [org.users.emp!.id]);
    const emp = await login(env.app, 'emp@eng7.test');
    await emp.post('/v1/me/time-corrections', manual('2026-10-27'));
    await env.drain();
    const mail = mailTo('manager@eng7.test').at(-1)!;
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});

describe('billing lifecycle', () => {
  it('tells the org admins once per milestone', async () => {
    const org = await makeOrg(env, 'bill1', 'pro', 5);
    await env.deps.pool.query(`UPDATE subscriptions SET status = 'trialing', trial_ends_at = $2 WHERE organization_id = $1`, [org.id, env.clock.iso(6 * 86_400_000)]);
    const run = () => withScope(SYSTEM_SCOPE, () => runBillingLifecycle(env.deps));
    await run();
    await run();
    let items = (await inbox(org, 'admin')).items.filter((n: { category: string }) => n.category === 'billing');
    expect(items.map((n: { title: string }) => n.title)).toEqual(['Your Pro trial ends in 6 days']);
    expect(items[0].link).toBe('/admin/billing');
    // Employees never get billing notices.
    expect((await inbox(org, 'emp')).items.filter((n: { category: string }) => n.category === 'billing')).toHaveLength(0);

    // A day before the end: the 1-day notice, once.
    env.clock.advance(5.5 * 86_400_000);
    org.admin = await login(env.app, 'admin@bill1.test');
    await run();
    await run();
    items = (await inbox(org, 'admin')).items.filter((n: { category: string }) => n.category === 'billing');
    expect(items.map((n: { title: string }) => n.title)).toEqual(['Your Pro trial ends in 1 day', 'Your Pro trial ends in 6 days']);
  });

  it('a failed payment, then 3 days of grace left, then inactive', async () => {
    const org = await makeOrg(env, 'bill2', 'pro', 5);
    await env.deps.pool.query(`UPDATE subscriptions SET status = 'past_due' WHERE organization_id = $1`, [org.id]);
    const run = () => withScope(SYSTEM_SCOPE, () => runBillingLifecycle(env.deps));
    await run();
    env.clock.advance(11.5 * 86_400_000);
    await run();
    env.clock.advance(3 * 86_400_000);
    await run();
    await run();
    org.admin = await login(env.app, 'admin@bill2.test');
    const titles = (await inbox(org, 'admin')).items.filter((n: { category: string }) => n.category === 'billing').map((n: { title: string }) => n.title);
    expect(titles).toEqual([
      'Your subscription is inactive — nothing is being collected',
      'Tracking stops in 3 days',
      'A payment failed — update your payment method',
    ]);
    await env.drain();
    expect(mailTo('admin@bill2.test').map((m) => m.subject)).toHaveLength(3);
  });
});

describe('row-level security on the engine tables', () => {
  it('every table with an organization_id forces row-level security', async () => {
    const r = await env.deps.pool.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY 1`);
    // Two exceptions, neither read through a tenant session: signup_requests exist before
    // their organization does, and deletion_certificates outlive the organization they describe.
    expect(r.rows.map((x) => x.relname)).toEqual(['deletion_certificates', 'signup_requests']);
  });
});
