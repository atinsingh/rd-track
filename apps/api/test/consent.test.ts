import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
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
    expect((await shown(d)).version).toBe(1);

    const wider = await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: { apps: { capture_app_name: true }, location: { capture: true } }, change_note: 'more', confirm_expansion: true,
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
    expect(await shown(d)).toMatchObject({ version: 2, text: 'Our own agreement.', status: 'pending' });
    expect((await start(d)).body.error.code).toBe('consent_required');

    // Another organization is untouched and can't see or answer this one.
    expect(await shown(od)).toMatchObject({ version: 1, status: 'accepted' });
    expect((await other.admin.get(`/v1/users/${org.users.emp!.id}/consent`)).status).toBe(404);
    expect((await other.admin.get('/v1/admin/consent')).body.custom_text).toBeNull();

    const reset = await org.admin.put('/v1/admin/consent', { custom_text: null });
    expect(reset.body).toMatchObject({ version: 3, custom_text: null });
    expect((await shown(d)).text).toContain('cons5 Inc');
  });
});
