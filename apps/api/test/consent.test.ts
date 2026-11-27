import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE, withScope } from '../src/db/tenant-scope';
import { pendingDueAt, runConsentReminders } from '../src/modules/consent/service';
import { answerConsent, bucket, deviceReq, enrollDevice, event, makeOrg, sendBatch, testEnv, type TestEnv } from './helpers';

/** The monitoring agreement: asked before tracking, enforced by the server, versioned, kept as proof. */

let env: TestEnv;
beforeAll(async () => {
  env = await testEnv();
});
afterAll(() => env.close());

const shown = async (d: Parameters<typeof deviceReq>[1]) => (await deviceReq(env, d, 'GET', '/v1/device/consent')).body;
const start = (d: Parameters<typeof deviceReq>[1]) =>
  deviceReq(env, d, 'POST', '/v1/sessions', { session_id: randomUUID(), client_started_at: env.clock.iso() });

describe('monitoring consent', () => {
  it('refuses every tracking endpoint until the agreement is accepted', async () => {
    const org = await makeOrg(env, 'cons1');
    const d = await enrollDevice(env, org, 'emp', { consent: false });

    const agreement = await shown(d);
    expect(agreement).toMatchObject({ version: 1, status: 'pending', decided_at: null });
    expect(agreement.text).toContain('cons1 Inc');
    expect(agreement.text_sha256).toMatch(/^[0-9a-f]{64}$/);

    const sid = randomUUID();
    for (const r of [
      await start(d),
      await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, env.clock.iso())]),
      await deviceReq(env, d, 'POST', '/v1/device/heartbeat', {
        agent_version: '0.1.0', client_time: env.clock.iso(), permissions: {}, outbox_depth: 0, applied_policy_revision: null,
      }),
      await deviceReq(env, d, 'GET', '/v1/device/policy'),
      await deviceReq(env, d, 'POST', '/v1/screenshots/upload-intents', { session_id: sid, content_type: 'image/webp' }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('consent_required');
    }
    expect((await env.deps.pool.query('SELECT count(*)::int AS n FROM work_sessions WHERE device_id = $1', [d.id])).rows[0].n).toBe(0);

    // The app shows the agreement and can always fetch it; once accepted, tracking works.
    await answerConsent(env, d, 'accepted');
    expect((await shown(d)).status).toBe('accepted');
    expect((await start(d)).status).toBe(201);
  });

  it('records accept and decline append-only with the version, text hash, server-seen IP, user and device', async () => {
    const org = await makeOrg(env, 'cons2');
    const d = await enrollDevice(env, org, 'emp', { consent: false });
    const a = await shown(d);
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/device/consent',
      payload: { version: a.version, text_sha256: a.text_sha256, decision: 'declined' },
      // The client prepends a made-up address; only the hop our load balancer added counts (TRUST_PROXY_HOPS=1).
      headers: { authorization: `Device ${d.credential}`, 'x-forwarded-for': '203.0.113.7, 192.0.2.50' },
      remoteAddress: '198.51.100.20',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('declined');
    expect((await start(d)).body.error.code).toBe('consent_required');

    const mine = await org.users.emp!.client.get('/v1/me/consent');
    expect(mine.body).toMatchObject({ required_version: 1, status: 'declined' });
    expect(mine.body.records).toHaveLength(1);
    expect(mine.body.records[0]).toMatchObject({
      version: 1, decision: 'declined', text_sha256: a.text_sha256, text: a.text, device_id: d.id, device_name: 'Test laptop',
    });
    expect(mine.body.records[0].ip).toBe('192.0.2.50');

    // Admins see it on the person's page; employees cannot read someone else's.
    const asAdmin = await org.admin.get(`/v1/users/${org.users.emp!.id}/consent`);
    expect(asAdmin.body.records).toHaveLength(1);
    expect((await org.users.emp2!.client.get(`/v1/users/${org.users.emp!.id}/consent`)).status).toBe(403);

    // Changing their mind adds a record; nothing is rewritten.
    await answerConsent(env, d, 'accepted');
    const after = await org.admin.get(`/v1/users/${org.users.emp!.id}/consent`);
    expect(after.body.status).toBe('accepted');
    expect(after.body.records.map((r: { decision: string }) => r.decision)).toEqual(['accepted', 'declined']);
    await expect(withScope(org.id, () => env.deps.pool.query(`UPDATE consent_records SET decision = 'accepted'`))).rejects.toThrow(/append-only/);
    await expect(withScope(org.id, () => env.deps.pool.query(`DELETE FROM consent_records`))).rejects.toThrow(/append-only/);
  });

  it('a decline ends the open session, and the team report shows it', async () => {
    const org = await makeOrg(env, 'cons7');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, env.clock.iso())]);
    await answerConsent(env, d, 'declined');
    const session = await env.deps.pool.query('SELECT state, stop_reason FROM work_sessions WHERE id = $1', [sid]);
    expect(session.rows[0]).toEqual({ state: 'stopped', stop_reason: 'consent_required' });
    const report = await org.admin.get('/v1/org/report?from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z');
    const emp = report.body.members.find((m: { user_id: string }) => m.user_id === org.users.emp!.id);
    expect(emp.consent).toBe('declined');
  });

  it('refuses an answer to text or a version that is no longer current', async () => {
    const org = await makeOrg(env, 'cons3');
    const d = await enrollDevice(env, org, 'emp', { consent: false });
    const a = await shown(d);
    const wrong = await deviceReq(env, d, 'POST', '/v1/device/consent', { version: a.version, text_sha256: 'f'.repeat(64), decision: 'accepted' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('consent_outdated');
    const old = await deviceReq(env, d, 'POST', '/v1/device/consent', { version: 2, text_sha256: a.text_sha256, decision: 'accepted' });
    expect(old.status).toBe(409);
  });

  it('asks again when a policy collects more, refusing tracking until then', async () => {
    const org = await makeOrg(env, 'cons4');
    const d = await enrollDevice(env, org, 'emp');
    const sid = randomUUID();
    expect((await sendBatch(env, d, [event(d, sid, 'session.started.v1', {}, env.clock.iso())])).status).toBe(200);

    // A restriction is not an expansion: no new version.
    const narrower = await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: { apps: { capture_app_name: false } }, change_note: 'less',
    });
    expect(narrower.status).toBe(200);
    // Collecting less is covered by what they accepted: no new answer, tracking goes on.
    expect(await shown(d)).toMatchObject({ version: 1, status: 'accepted' });
    expect((await sendBatch(env, d, [bucket(d, sid, env.clock.iso())])).body.results[0].status).toBe('accepted');

    const wider = await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: {
        apps: { capture_app_name: true },
        location: { capture: true },
        work_hours: { timezone: 'America/Toronto', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      },
      change_note: 'more',
      confirm_expansion: true,
    });
    expect(wider.status).toBe(200);
    const v2 = await shown(d);
    expect(v2).toMatchObject({ version: 2, status: 'pending' });
    expect(v2.text).toContain('IP address');

    // The agent is refused at once; what it queued under the accepted policy arrives after the new answer.
    const queued = [bucket(d, sid, env.clock.iso())];
    expect((await sendBatch(env, d, queued)).body.error.code).toBe('consent_required');
    await answerConsent(env, d, 'accepted');
    expect((await sendBatch(env, d, queued)).body.results[0].status).toBe('accepted');

    const team = await org.admin.get(`/v1/teams/${org.teamId}/report?from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z`);
    const status = Object.fromEntries(team.body.members.map((m: { user_id: string; consent: string }) => [m.user_id, m.consent]));
    expect(status[org.users.emp!.id]).toBe('accepted');
    expect(status[org.users.emp2!.id]).toBe('pending');
  });

  it('versions the admin’s own text and keeps it per organization', async () => {
    const org = await makeOrg(env, 'cons5');
    const other = await makeOrg(env, 'cons6');
    const d = await enrollDevice(env, org, 'emp');
    const od = await enrollDevice(env, other, 'emp');

    const editor = await org.admin.get('/v1/admin/consent');
    expect(editor.body).toMatchObject({ version: 1, custom_text: null });
    expect(editor.body.generated_text).toContain('cons5 Inc');
    expect((await org.users.emp!.client.get('/v1/admin/consent')).status).toBe(403);

    const put = await org.admin.put('/v1/admin/consent', { custom_text: 'Our own agreement.' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ version: 2, custom_text: 'Our own agreement.' });
    expect(put.body.history[0]).toMatchObject({ version: 2, reason: 'text_edited' });
    const custom = await shown(d);
    // New wording, same collection: what they accepted still covers it, so they aren't asked again.
    expect(custom).toMatchObject({ version: 2, status: 'accepted' });
    // The admin's text, followed by what is collected about this person.
    expect(custom.text).toMatch(/^Our own agreement\.\n\nWhat is collected\n/);
    expect((await start(d)).status).toBe(201);

    // Another organization is untouched and can't see or answer this one.
    expect(await shown(od)).toMatchObject({ version: 1, status: 'accepted' });
    expect((await other.admin.get(`/v1/users/${org.users.emp!.id}/consent`)).status).toBe(404);
    expect((await other.admin.get('/v1/admin/consent')).body.custom_text).toBeNull();

    const reset = await org.admin.put('/v1/admin/consent', { custom_text: null });
    expect(reset.body).toMatchObject({ version: 3, custom_text: null });
    expect((await shown(d)).text).toContain('cons5 Inc');
  });

  it('needs a new acceptance when joining a team that collects more, without a new version', async () => {
    const org = await makeOrg(env, 'cons8');
    const d = await enrollDevice(env, org, 'emp');
    // An empty team turns on screenshots: nobody's collection grows, so no new version.
    const team = await org.admin.post('/v1/admin/teams', { name: 'Screens' });
    const pub = await org.admin.put(`/v1/policies/team/${team.body.id}`, {
      settings: { screenshots: { enabled: true } }, change_note: 'screens', confirm_expansion: true,
    });
    expect(pub.status).toBe(200);
    expect((await start(d)).status).toBe(201);

    // Joining it widens what is collected about them beyond what they accepted.
    await org.admin.post(`/v1/admin/teams/${team.body.id}/members`, { user_id: org.users.emp!.id, role: 'member' });
    const now = await shown(d);
    expect(now).toMatchObject({ version: 1, status: 'pending' });
    expect(now.text).toContain('Screenshots, about one every');
    for (const r of [
      await start(d),
      await deviceReq(env, d, 'POST', '/v1/screenshots/upload-intents', { session_id: randomUUID(), content_type: 'image/webp' }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('consent_required');
    }
    await answerConsent(env, d, 'accepted');
    expect((await start(d)).status).toBe(201);

    // Leaving it collects less: no new answer.
    await org.admin.req('DELETE', `/v1/admin/teams/${team.body.id}/members/${org.users.emp!.id}`);
    expect((await shown(d)).status).toBe('accepted');
    expect((await start(d)).status).toBe(201);
  });

  it('tells managers and admins about a decline, and lets them ask again', async () => {
    const org = await makeOrg(env, 'cons9');
    const d = await enrollDevice(env, org, 'emp');
    await answerConsent(env, d, 'declined');
    for (const c of [org.users.manager!.client, org.admin]) {
      const n = await c.get('/v1/me/notifications');
      expect(n.body.items.map((i: { kind: string }) => i.kind)).toContain('consent_declined');
    }
    // Privacy notices are mandatory, so both are emailed too.
    const mailed = await env.deps.pool.query(
      `SELECT n.user_id FROM jobs j JOIN notifications n ON n.id::text = j.payload->>'notification_id'
       WHERE j.kind = 'notification.email' AND n.kind = 'consent_declined' AND n.organization_id = $1`,
      [org.id],
    );
    expect(mailed.rows.map((r) => r.user_id).sort()).toEqual([org.users.manager!.id, org.adminId].sort());
    const emp = org.users.emp!;
    expect((await emp.client.get('/v1/me/notifications')).body.items.map((i: { kind: string }) => i.kind)).not.toContain('consent_declined');

    // The manager sees the status (not the stored answers); someone outside their teams can't ask.
    const seen = await org.users.manager!.client.get(`/v1/users/${emp.id}/consent`);
    expect(seen.body).toMatchObject({ status: 'declined', records: [] });
    expect((await org.users.emp2!.client.post(`/v1/users/${emp.id}/consent/ask-again`, {})).status).toBe(403);

    const asked = await org.users.manager!.client.post(`/v1/users/${emp.id}/consent/ask-again`, {});
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ status: 'pending', records: [] });
    expect((await org.admin.post(`/v1/users/${emp.id}/consent/ask-again`, {})).body.records).toHaveLength(2);
    expect(asked.body.asked_again_at).not.toBeNull();
    // The app shows the agreement again; tracking still waits for an acceptance.
    expect((await shown(d)).status).toBe('pending');
    expect((await start(d)).body.error.code).toBe('consent_required');
    const log = await env.deps.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'consent.asked_again' AND target_user_id = $1`, [emp.id]);
    expect(log.rows[0].n).toBe(2); // the manager's ask and the admin's
    await answerConsent(env, d, 'accepted');
    expect((await start(d)).status).toBe(201);
  });

  it('covers a project they tracked on without being a member', async () => {
    const org = await makeOrg(env, 'cons10');
    const d = await enrollDevice(env, org, 'emp');
    const side = await org.admin.post('/v1/admin/projects', { name: 'Side job' });
    const pub = await org.admin.put(`/v1/policies/project/${side.body.id}`, {
      settings: { screenshots: { enabled: true } }, change_note: 'screens', confirm_expansion: true,
    });
    expect(pub.status).toBe(200);
    const sid = randomUUID();
    expect((await deviceReq(env, d, 'POST', '/v1/sessions', { session_id: sid, project_id: side.body.id, client_started_at: env.clock.iso() })).status).toBe(201);
    // Once they track there, its screenshots are part of their agreement: nothing is uploaded before they accept it.
    const intent = await deviceReq(env, d, 'POST', '/v1/screenshots/upload-intents', { session_id: sid, content_type: 'image/webp' });
    expect(intent.body.error.code).toBe('consent_required');
    expect((await shown(d)).text).toContain('Screenshots, about one every');
    await answerConsent(env, d, 'accepted');
    expect((await deviceReq(env, d, 'POST', '/v1/screenshots/upload-intents', { session_id: sid, content_type: 'image/webp' })).status).not.toBe(403);
  });

  it('asks again only on the computer whose device policy collects more', async () => {
    const org = await makeOrg(env, 'cons11');
    const laptop = await enrollDevice(env, org, 'emp');
    const desktop = await enrollDevice(env, org, 'emp');
    const pub = await org.admin.put(`/v1/policies/device/${desktop.id}`, {
      settings: { screenshots: { enabled: true } }, change_note: 'screens here', confirm_expansion: true,
    });
    expect(pub.status).toBe(200);
    expect((await shown(laptop)).text).not.toContain('Screenshots, about one every');
    expect((await shown(desktop)).text).toContain('Screenshots, about one every');

    // The laptop collects what it did: its acceptance stands. It doesn't cover the desktop's screenshots.
    expect((await shown(laptop)).status).toBe('accepted');
    expect((await start(laptop)).status).toBe(201);
    expect((await start(desktop)).body.error.code).toBe('consent_required');
    const before = await org.admin.get(`/v1/users/${org.users.emp!.id}/consent`);
    expect(before.body.status).toBe('pending');
    await answerConsent(env, desktop, 'accepted');
    // Both stand: answering on one computer doesn't undo the other.
    expect((await shown(laptop)).status).toBe('accepted');
    expect((await shown(desktop)).status).toBe('accepted');
    expect((await org.admin.get(`/v1/users/${org.users.emp!.id}/consent`)).body.status).toBe('accepted');
  });

  it('reports the end of the first full office day after the agreement was shown', () => {
    // Monday morning → end of Tuesday; Friday → end of Monday (the weekend doesn't count).
    expect(new Date(pendingDueAt(Date.parse('2026-11-02T15:00:00Z'), [1, 2, 3, 4, 5], 'America/Toronto')).toISOString()).toBe('2026-11-04T05:00:00.000Z');
    expect(new Date(pendingDueAt(Date.parse('2026-11-06T15:00:00Z'), [1, 2, 3, 4, 5], 'UTC')).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(new Date(pendingDueAt(Date.parse('2026-11-06T15:00:00Z'), [6], 'UTC')).toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  it('tells managers and admins once per version about someone who never answers', async () => {
    const at = (iso: string) => (env.clock.t = Date.parse(iso));
    at('2026-11-02T10:00:00Z'); // a Monday
    const org = await makeOrg(env, 'cons12');
    const d = await enrollDevice(env, org, 'emp', { consent: false });
    await enrollDevice(env, org, 'emp2'); // answered: never reported
    await env.deps.pool.query(`UPDATE devices SET enrolled_at = '2026-11-02T10:00:00Z' WHERE organization_id = $1`, [org.id]);
    const run = () => withScope(SYSTEM_SCOPE, () => runConsentReminders(env.deps));
    const pending = async () =>
      (
        await env.deps.pool.query(
          `SELECT n.user_id, j.id IS NOT NULL AS mailed FROM notifications n
           LEFT JOIN jobs j ON j.kind = 'notification.email' AND j.payload->>'notification_id' = n.id::text
           WHERE n.organization_id = $1 AND n.kind = 'consent_pending' ORDER BY n.user_id`,
          [org.id],
        )
      ).rows;

    at('2026-11-03T20:00:00Z'); // still within their first working day after it was shown
    await run();
    expect(await pending()).toEqual([]);

    at('2026-11-04T12:00:00Z');
    await run();
    await run();
    const told = await pending();
    expect(told.map((r) => r.user_id).sort()).toEqual([org.users.manager!.id, org.adminId].sort());
    expect(told.every((r) => r.mailed)).toBe(true);
    const title = await env.deps.pool.query(`SELECT title FROM notifications WHERE organization_id = $1 AND kind = 'consent_pending' LIMIT 1`, [org.id]);
    expect(title.rows[0].title).toMatch(/hasn’t answered the monitoring agreement$/);

    // Once they answer, nothing more is sent.
    await answerConsent(env, d, 'accepted');
    at('2026-11-09T12:00:00Z');
    await run();
    expect(await pending()).toHaveLength(2);
  });
});
