import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notify } from '../src/modules/engine/notify';
import { routineAt } from '../src/modules/family/service';
import { hashPassword } from '../src/lib/crypto';
import { Client, PASSWORD, deviceReq, enrollDevice, login, makeOrg, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** Family (docs/design/08-family-plan.md, phase 1): children, rules, today, transparency, devices. */

let env: TestEnv;
let business: Org;
let parent: Client;
let familyId: string;
let parentId: string;

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  business = await makeOrg(env, 'biz');
  // A family signs up itself.
  const res = await env.app.inject({
    method: 'POST',
    url: '/v1/signup',
    payload: { org_name: 'The Moreno family', display_name: 'Ana Moreno', email: 'ana@family.test', password: 'a-long-enough-password', accept_terms: true, kind: 'family' },
  });
  expect(res.statusCode).toBe(202);
  const mail = env.email.sent.at(-1)!;
  expect(mail.subject).toBe('Confirm your RoundDigital Family account');
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  const verified = await env.app.inject({ method: 'POST', url: '/v1/signup/verify', payload: { token } });
  expect(verified.statusCode).toBe(201);
  parent = new Client(env.app, String(verified.headers['set-cookie']).split(';')[0]!);
  const me = (await parent.get('/v1/me')).body;
  familyId = me.organization.id;
  parentId = me.user.id;
  // The family lives in Toronto.
  await env.deps.pool.query(`UPDATE users SET timezone = 'America/Toronto' WHERE id = $1`, [parentId]);
});

const maya = { display_name: 'Maya', birth_year: 2014, birth_month: 5, region: 'CA-QC', color: 'amber' };
const leo = { display_name: 'Leo', birth_year: 2017, birth_month: 9, region: 'CA-QC', color: 'teal' };

async function addChild(body: object = maya) {
  const r = await parent.post('/v1/family/children', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; age: number; teen: boolean; adult_on: string };
}

/** Connects a computer for a child the way a parent does: sign in, confirm for the child. */
async function connectForChild(childId: string, name = 'Maya’s laptop'): Promise<Device> {
  const open = JSON.parse(
    (await env.app.inject({ method: 'POST', url: '/v1/devices/link-requests', payload: { device_name: name, os: 'macos' } })).body,
  );
  expect((await parent.post(`/v1/devices/link-requests/${open.request_id}/approve`, { child_id: childId })).body).toEqual({ status: 'approved' });
  const tok = JSON.parse(
    (await env.app.inject({ method: 'POST', url: `/v1/devices/link-requests/${open.request_id}/token`, payload: { poll_secret: open.poll_secret } })).body,
  );
  const res = await env.app.inject({
    method: 'POST',
    url: '/v1/devices/enroll',
    payload: { enrollment_code: tok.enrollment_code, device_name: name, os: 'macos', os_version: '15.6', agent_version: '0.2.0' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const b = JSON.parse(res.body);
  return { id: b.device_id, credential: b.device_credential, userId: b.user_id, orgId: b.organization_id, seq: 0, publicKeyB64: b.policy_signing_key.public_key_b64 };
}

describe('family signup', () => {
  it('creates a family on the Family plan, with a parent who isn’t tracked', async () => {
    const me = (await parent.get('/v1/me')).body;
    expect(me.organization).toMatchObject({ name: 'The Moreno family', kind: 'family', plan: 'family', license: 'active' });
    expect(me.user).toMatchObject({ org_role: 'org_admin', tracking_enabled: false });
    // Never a Pro trial: no workforce entitlements at all.
    expect(me.entitlements).toEqual([]);
    const sub = (await parent.get('/v1/billing/subscription')).body;
    expect(sub).toMatchObject({ plan: 'family', status: 'active', entitlements: [] });
    expect((await business.admin.get('/v1/me')).body.organization.kind).toBe('business');
  });

  it('keeps families on the Family plan', async () => {
    const r = await parent.post('/v1/billing/plan', { plan: 'pro', seats: 2 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_business');
  });
});

describe('children', () => {
  it('adds, lists and edits children, with their age and teen status', async () => {
    const m = await addChild();
    // 26 Oct 2026: Maya is 12, a teen in Québec only at 14.
    expect(m).toMatchObject({ age: 12, teen: false, adult_on: '2032-05-01', devices: 0 });
    const list = (await parent.get('/v1/family/children')).body.items;
    expect(list.map((c: { display_name: string }) => c.display_name)).toContain('Maya');
    const edited = await parent.req('PATCH', `/v1/family/children/${m.id}`, { region: 'CA', birth_year: 2013 });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ age: 13, teen: true, region: 'CA' });
    // Children are not people in the workforce sense.
    expect((await parent.get('/v1/admin/users')).body.items.some((u: { id: string }) => u.id === m.id)).toBe(false);
    const audit = (await parent.get(`/v1/audit-events?action=family.child_updated`)).body.items;
    expect(audit[0].metadata).toMatchObject({ fields: ['birth_year', 'region'] });
  });

  it('is for children only, and at most five', async () => {
    const adult = await parent.post('/v1/family/children', { ...maya, display_name: 'Grown', birth_year: 2008, birth_month: 10 });
    expect(adult.status).toBe(422);
    expect(adult.body.error.code).toBe('adult');
    const n = (await parent.get('/v1/family/children')).body.items.length;
    for (let i = n; i < 5; i++) await addChild({ ...leo, display_name: `Kid ${i}` });
    const full = await parent.post('/v1/family/children', leo);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('family_full');
    // Make room again for the rest of the file.
    for (const c of (await parent.get('/v1/family/children')).body.items.filter((c: { display_name: string }) => c.display_name.startsWith('Kid ')))
      expect((await parent.req('DELETE', `/v1/family/children/${c.id}`)).status).toBe(200);
  });

  it('is only for a family’s parents', async () => {
    const biz = await business.admin.get('/v1/family/children');
    expect(biz.status).toBe(403);
    expect(biz.body.error.code).toBe('not_family');
    // Someone in the family who isn't a parent (an admin role) is refused too.
    const u = await env.deps.pool.query(
      `INSERT INTO users (organization_id, email, display_name, password_hash, org_role, tracking_enabled) VALUES ($1, 'aunt@family.test', 'Aunt', $2, 'employee', false) RETURNING id`,
      [familyId, await hashPassword(PASSWORD)],
    );
    expect(u.rowCount).toBe(1);
    const aunt = await login(env.app, 'aunt@family.test');
    const r = await aunt.get('/v1/family/children');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });

  it('never lets a child sign in, and never emails or notifies them', async () => {
    const c = await addChild({ ...leo, display_name: 'Nina' });
    const row = (await env.deps.pool.query('SELECT email, password_hash FROM users WHERE id = $1', [c.id])).rows[0];
    expect(row).toEqual({ email: `child-${c.id}@family.invalid`, password_hash: null });
    // Even with a password somehow set, signing in is refused.
    await env.deps.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [c.id, await hashPassword(PASSWORD)]);
    const res = await env.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: row.email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    const before = env.email.sent.length;
    await env.app.inject({ method: 'POST', url: '/v1/auth/password-reset', payload: { email: row.email } });
    await env.deps.email.send({ to: row.email, subject: 'x', text: 'y' });
    expect(env.email.sent.length).toBe(before);

    // A notice about a child's computer goes to the parents, linking to the child; anything else is dropped.
    const n1 = await notify(env.deps.pool, familyId, [c.id], { kind: 'device_stale', category: 'devices', title: 'Nina’s laptop stopped syncing', body: '' });
    expect(n1).toBe(1);
    const mine = (await env.deps.pool.query(`SELECT user_id, link FROM notifications WHERE title = 'Nina’s laptop stopped syncing'`)).rows;
    expect(mine).toEqual([{ user_id: parentId, link: `/family/children/${c.id}` }]);
    expect(await notify(env.deps.pool, familyId, [c.id], { kind: 'todo', category: 'my_requests', title: 'For a child', body: '' })).toBe(0);
    await env.drain();
    expect(env.email.sent.some((m) => m.to.endsWith('@family.invalid'))).toBe(false);
    await parent.req('DELETE', `/v1/family/children/${c.id}`);
  });
});

describe('rules', () => {
  let child: { id: string };
  beforeAll(async () => {
    child = (await parent.get('/v1/family/children')).body.items.find((c: { display_name: string }) => c.display_name === 'Maya');
  });

  it('starts from the defaults, then the family’s document, then the child’s', async () => {
    const empty = (await parent.get('/v1/family/rules')).body;
    expect(empty).toMatchObject({ child_id: null, document: {}, updated_at: null });
    expect(empty.sources.web).toBe('default');
    const rev0 = empty.revision;

    const fam = await parent.put('/v1/family/rules', { rules: { blocked_apps: ['com.roblox.client'], allow_requests: false } });
    expect(fam.status, JSON.stringify(fam.body)).toBe(200);
    expect(fam.body.revision).toBe(rev0 + 1);
    expect(fam.body.sources).toMatchObject({ blocked_apps: 'family', allow_requests: 'family', web: 'default' });

    const own = await parent.put(`/v1/family/children/${child.id}/rules`, { rules: { blocked_apps: [] } });
    expect(own.status).toBe(200);
    expect(own.body.document).toEqual({ blocked_apps: [] });
    expect(own.body.resolved.blocked_apps).toEqual([]);
    expect(own.body.resolved.allow_requests).toBe(false);
    expect(own.body.sources).toMatchObject({ blocked_apps: 'child', allow_requests: 'family' });
    expect(own.body.revision).toBe(rev0 + 2);

    const bad = await parent.put('/v1/family/rules', { rules: { screenshots: true } });
    expect(bad.status).toBe(400);
    const audit = (await parent.get('/v1/audit-events?action=family.rules_changed')).body.items;
    expect(audit[0].metadata).toMatchObject({ fields: ['blocked_apps'], scope: 'child' });
    expect(JSON.stringify(audit)).not.toContain('roblox');
  });

  it('works out the routine in force, across midnight', () => {
    const bedtime = { id: 'bedtime', kind: 'bedtime' as const, name: 'Bedtime', days: ['fri' as const], start: '21:00', end: '07:00', allow_apps: [] };
    expect(routineAt([bedtime], '2026-10-30', 'fri', 22 * 60)).toMatchObject({ endDate: '2026-10-31', endMinutes: 420 });
    expect(routineAt([bedtime], '2026-10-31', 'sat', 6 * 60)).toMatchObject({ endDate: '2026-10-31', endMinutes: 420 });
    expect(routineAt([bedtime], '2026-10-31', 'sat', 22 * 60)).toBeNull();
    expect(routineAt([bedtime], '2026-10-30', 'fri', 20 * 60)).toBeNull();
  });
});

describe('today, transparency and the child’s computer', () => {
  let child: { id: string };
  let dev: Device;
  beforeAll(async () => {
    child = (await parent.get('/v1/family/children')).body.items.find((c: { display_name: string }) => c.display_name === 'Maya');
    dev = await connectForChild(child.id);
  });

  it('connects a computer for the child the parent chose', async () => {
    expect(dev.userId).toBe(child.id);
    const log = (await parent.get(`/v1/audit-events?action=device.link_approved`)).body.items;
    expect(log[0]).toMatchObject({ target_user_id: child.id });
    expect(log[0].metadata).toMatchObject({ for_child: true });

    const open = async () =>
      JSON.parse((await env.app.inject({ method: 'POST', url: '/v1/devices/link-requests', payload: { device_name: 'X', os: 'windows' } })).body).request_id;
    const noChild = await parent.post(`/v1/devices/link-requests/${await open()}/approve`, {});
    expect(noChild.status).toBe(422);
    expect(noChild.body.error.code).toBe('child_required');
    const notOurs = await parent.post(`/v1/devices/link-requests/${await open()}/approve`, { child_id: business.users.emp!.id });
    expect(notOurs.status).toBe(404);
    const biz = await business.users.emp!.client.post(`/v1/devices/link-requests/${await open()}/approve`, { child_id: child.id });
    expect(biz.status).toBe(422);
    expect(biz.body.error.code).toBe('not_family');
  });

  it('shows today’s screen time against the budget, the routine now and the devices', async () => {
    // 01:30 on Tuesday 27 Oct in Toronto (EDT): bedtime runs until 07:00.
    env.clock.t = new Date('2026-10-27T05:30:00Z').getTime();
    parent = await login(env.app, 'ana@family.test', 'a-long-enough-password');
    await parent.put('/v1/family/rules', {
      rules: {
        routines: [{ id: 'bedtime', kind: 'bedtime', name: 'Bedtime', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '21:00', end: '07:00', allow_apps: [] }],
        daily_budget: { mon: 60, tue: 90, wed: 60, thu: 60, fri: 120, sat: 180, sun: 180 },
        // A PUT replaces the whole document: keep what the family set before.
        blocked_apps: ['com.roblox.client'],
        allow_requests: false,
      },
    });
    const sid = randomUUID();
    await env.deps.pool.query(
      `INSERT INTO work_sessions (id, organization_id, user_id, device_id, state, source, started_at) VALUES ($1, $2, $3, $4, 'active', 'agent', $5)`,
      [sid, familyId, child.id, dev.id, '2026-10-27T03:00:00Z'],
    );
    const usage = async (name: string, at: string, seconds: number) =>
      env.deps.pool.query(
        `INSERT INTO app_usage (organization_id, session_id, user_id, event_id, app_identifier, app_name, started_at, duration_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [familyId, sid, child.id, randomUUID(), name.toLowerCase(), name, at, seconds],
      );
    await usage('Minecraft', '2026-10-27T03:30:00Z', 1200); // 23:30 yesterday, local: not today
    await usage('Minecraft', '2026-10-27T04:10:00Z', 1800);
    await usage('Chrome', '2026-10-27T04:50:00Z', 600);
    await env.deps.pool.query('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [dev.id, '2026-10-27T05:28:00Z']);

    const t = (await parent.get(`/v1/family/children/${child.id}/today`)).body;
    expect(t).toMatchObject({
      child_id: child.id,
      date: '2026-10-27',
      used_minutes: 40,
      budget_minutes: 90,
      apps: [
        { name: 'Minecraft', minutes: 30 },
        { name: 'Chrome', minutes: 10 },
      ],
      routine_now: { name: 'Bedtime', until: '2026-10-27T11:00:00.000Z' },
      paused_until: null,
    });
    expect(t.devices).toEqual([{ id: dev.id, name: 'Maya’s laptop', os: 'macos', last_seen_at: '2026-10-27T05:28:00.000Z', online: true }]);
  });

  it('names the built-in bedtime in the reader’s language, from their choice or their browser', async () => {
    const fresh = await addChild({ ...leo, display_name: 'Zoé' });
    // The family document now sets routines; a child-only view of the defaults needs none set.
    const famDoc = (await parent.get('/v1/family/rules')).body.document;
    await parent.put('/v1/family/rules', { rules: { ...famDoc, routines: undefined } });
    const fr = await env.app.inject({
      method: 'GET',
      url: `/v1/family/children/${fresh.id}/rules`,
      headers: { cookie: parent.cookie, 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' },
    });
    expect(JSON.parse(fr.body).resolved.routines[0].name).toBe('Coucher');
    expect((await parent.get(`/v1/family/children/${fresh.id}/rules`)).body.resolved.routines[0].name).toBe('Bedtime');
    const t = await env.app.inject({ method: 'GET', url: `/v1/family/children/${fresh.id}/transparency`, headers: { cookie: parent.cookie, 'accept-language': 'fr' } });
    expect(JSON.parse(t.body).never_sees).toContain('Tes messages, tes discussions ou tes courriels.');
    // A language the parent chose wins over the browser's.
    await env.deps.pool.query(`UPDATE users SET locale = 'en-CA' WHERE id = $1`, [parentId]);
    const en = await env.app.inject({ method: 'GET', url: `/v1/family/children/${fresh.id}/transparency`, headers: { cookie: parent.cookie, 'accept-language': 'fr' } });
    expect(JSON.parse(en.body).never_sees).toContain('Your messages, chats or emails.');
    await env.deps.pool.query(`UPDATE users SET locale = NULL WHERE id = $1`, [parentId]);
    await parent.put('/v1/family/rules', { rules: famDoc });
    await parent.req('DELETE', `/v1/family/children/${fresh.id}`);
  });

  it('tells the child what their parents can and can never see, in the reader’s language', async () => {
    await env.deps.pool.query(`UPDATE users SET locale = 'fr-CA' WHERE id = $1`, [parentId]);
    const t = (await parent.get(`/v1/family/children/${child.id}/transparency`)).body;
    await env.deps.pool.query(`UPDATE users SET locale = NULL WHERE id = $1`, [parentId]);
    expect(t.teen).toBe(true); // 13 in Canada after the edit above
    expect(t.can_see).toContain('Combien de sites ont été bloqués, jamais lesquels ni les pages.');
    expect(t.never_sees).toContain('Tes messages, tes discussions ou tes courriels.');
    expect(t.never_sees).toContain('Les touches que tu frappes ou ce que tu écris.');
    // Asking for more time is off for this family, so it isn't listed.
    expect(t.can_see.join(' ')).not.toContain('plus de temps');
    expect(t.rules.allow_requests).toBe(false);
  });

  it('gives the child’s computer its rules, signed like a policy', async () => {
    const res = await deviceReq(env, dev, 'GET', '/v1/device/family-rules');
    expect(res.status).toBe(200);
    const payload = Buffer.from(res.body.payload_b64, 'base64');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(dev.publicKeyB64, 'base64')]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, payload, key, Buffer.from(res.body.signature_b64, 'base64'))).toBe(true);
    const doc = JSON.parse(payload.toString());
    expect(doc).toMatchObject({ organization_id: familyId, child_id: child.id, device_id: dev.id });
    expect(doc.rules.daily_budget.tue).toBe(90);
    expect(doc.revision).toBe((await parent.get('/v1/family/rules')).body.revision);
    // And no screenshots or domains in its policy, whatever anyone publishes.
    const pol = await deviceReq(env, dev, 'GET', '/v1/device/policy');
    const settings = JSON.parse(Buffer.from(pol.body.payload_b64, 'base64').toString()).settings;
    expect(settings.screenshots.enabled).toBe(false);
    expect(settings.apps.capture_domains).toBe(false);

    business.admin = await login(env.app, 'admin@biz.test');
    const work = await enrollDevice(env, business, 'emp');
    expect((await deviceReq(env, work, 'GET', '/v1/device/family-rules')).status).toBe(404);
  });

  it('removes a child for good: computers disconnected, data erased', async () => {
    const r = await parent.req('DELETE', `/v1/family/children/${child.id}`);
    expect(r).toEqual({ status: 200, body: { removed: true } });
    const q = (sql: string) => env.deps.pool.query(sql, [child.id]).then((x) => x.rows);
    expect(await q('SELECT count(*)::int AS n FROM app_usage WHERE user_id = $1')).toEqual([{ n: 0 }]);
    expect(await q('SELECT count(*)::int AS n FROM work_sessions WHERE user_id = $1')).toEqual([{ n: 0 }]);
    expect(await q('SELECT count(*)::int AS n FROM child_profiles WHERE user_id = $1')).toEqual([{ n: 0 }]);
    expect(await q('SELECT count(*)::int AS n FROM family_rules WHERE child_user_id = $1')).toEqual([{ n: 0 }]);
    expect(await q(`SELECT credential_status FROM devices WHERE user_id = $1`)).toEqual([{ credential_status: 'revoked' }]);
    expect(await q(`SELECT display_name, status FROM users WHERE id = $1`)).toEqual([{ display_name: 'Erased person', status: 'deactivated' }]);
    expect((await parent.get(`/v1/family/children/${child.id}`)).status).toBe(404);
    expect((await deviceReq(env, dev, 'GET', '/v1/device/family-rules')).status).toBe(401);
    const removed = (await parent.get('/v1/audit-events?action=family.child_removed')).body.items;
    expect(removed.filter((e: { target_user_id: string }) => e.target_user_id === child.id)).toHaveLength(1);
  });
});
