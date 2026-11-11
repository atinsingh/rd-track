import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, login, makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/** Signing in to connect a computer: the app's request, the browser's confirmation, the app's poll. */

let env: TestEnv;
let org: Org;

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'dl');
});

async function open(name = 'Studio Mac') {
  const res = await env.app.inject({ method: 'POST', url: '/v1/devices/link-requests', payload: { device_name: name, os: 'macos' } });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body) as { request_id: string; user_code: string; poll_secret: string; approve_url: string; expires_at: string; interval_seconds: number };
}

async function poll(id: string, secret: string) {
  const res = await env.app.inject({ method: 'POST', url: `/v1/devices/link-requests/${id}/token`, payload: { poll_secret: secret } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('device link requests', () => {
  it('connects the computer once the signed-in person confirms, and only once', async () => {
    const emp = org.users.emp!;
    const req = await open();
    expect(req.user_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    expect(req.poll_secret.length).toBeGreaterThanOrEqual(43);
    expect(req.approve_url).toBe(`${env.deps.config.webUrl}/connect?request=${req.request_id}`);
    expect(req.interval_seconds).toBe(2);
    expect(new Date(req.expires_at).getTime() - env.clock.t).toBe(10 * 60_000);

    expect(await poll(req.request_id, req.poll_secret)).toEqual({ status: 200, body: { status: 'pending' } });

    const view = await emp.client.get(`/v1/devices/link-requests/${req.request_id}`);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({ request_id: req.request_id, device_name: 'Studio Mac', os: 'macos', user_code: req.user_code, status: 'pending', expires_at: req.expires_at });

    const ok = await emp.client.post(`/v1/devices/link-requests/${req.request_id}/approve`);
    expect(ok).toEqual({ status: 200, body: { status: 'approved' } });
    expect((await emp.client.get(`/v1/devices/link-requests/${req.request_id}`)).body.status).toBe('approved');
    // Approving twice, or cancelling afterwards, is too late.
    expect((await emp.client.post(`/v1/devices/link-requests/${req.request_id}/approve`)).body.error.code).toBe('link_expired');
    expect((await emp.client.post(`/v1/devices/link-requests/${req.request_id}/deny`)).body.error.code).toBe('link_expired');

    const got = await poll(req.request_id, req.poll_secret);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe('approved');
    expect(typeof got.body.enrollment_code).toBe('string');
    const again = await poll(req.request_id, req.poll_secret);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('link_expired');
    expect((await emp.client.get(`/v1/devices/link-requests/${req.request_id}`)).body.status).toBe('used');

    const enrolled = await env.app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      payload: { enrollment_code: got.body.enrollment_code, device_name: 'Studio Mac', os: 'macos', os_version: '15.6', agent_version: '0.1.0' },
    });
    expect(enrolled.statusCode, enrolled.body).toBe(201);
    expect(JSON.parse(enrolled.body).user_id).toBe(emp.id);

    const log = (await org.admin.get(`/v1/audit-events?action=device.link_approved&actor_id=${emp.id}`)).body.items;
    expect(log).toHaveLength(1);
    expect(log[0].metadata).toMatchObject({ device_name: 'Studio Mac', os: 'macos' });
  });

  it('tells the app when the person cancels', async () => {
    const req = await open();
    expect(await org.users.emp2!.client.post(`/v1/devices/link-requests/${req.request_id}/deny`)).toEqual({ status: 200, body: { status: 'denied' } });
    expect((await org.users.emp2!.client.get(`/v1/devices/link-requests/${req.request_id}`)).body.status).toBe('denied');
    const res = await poll(req.request_id, req.poll_secret);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('link_denied');
    expect((await org.users.emp2!.client.post(`/v1/devices/link-requests/${req.request_id}/approve`)).body.error.code).toBe('link_expired');
  });

  it('expires after ten minutes', async () => {
    const req = await open();
    env.clock.advance(10 * 60_000 + 1);
    expect((await org.users.emp!.client.get(`/v1/devices/link-requests/${req.request_id}`)).body.status).toBe('expired');
    const approve = await org.users.emp!.client.post(`/v1/devices/link-requests/${req.request_id}/approve`);
    expect(approve.status).toBe(410);
    expect(approve.body.error.code).toBe('link_expired');
    const res = await poll(req.request_id, req.poll_secret);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('link_expired');
  });

  it('answers a wrong secret or an unknown request as not found', async () => {
    const req = await open();
    expect((await poll(req.request_id, 'x'.repeat(43))).status).toBe(404);
    expect((await poll('00000000-0000-4000-8000-000000000000', req.poll_secret)).status).toBe(404);
    expect((await poll('not-a-uuid', req.poll_secret)).status).toBe(404);
    const unknown = await org.users.emp!.client.get('/v1/devices/link-requests/00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
  });

  it('refuses when tracking is off for the person, with the reason', async () => {
    const r = await org.admin.post('/v1/admin/users', { email: 'fin@dl.test', display_name: 'dl fin', org_role: 'finance', tracking_enabled: false, password: PASSWORD });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fin = await login(env.app, 'fin@dl.test');
    const req = await open();
    const res = await fin.post(`/v1/devices/link-requests/${req.request_id}/approve`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Tracking is off for your account/);
    expect((await poll(req.request_id, req.poll_secret)).body).toEqual({ status: 'pending' });
  });

  it('needs a signed-in person to see, confirm or cancel', async () => {
    const req = await open();
    for (const [method, path] of [
      ['GET', ''],
      ['POST', '/approve'],
      ['POST', '/deny'],
    ] as const) {
      const res = await env.app.inject({ method, url: `/v1/devices/link-requests/${req.request_id}${path}`, headers: method === 'POST' ? { 'x-rd-csrf': '1' } : {} });
      expect(res.statusCode, `${method} ${path}`).toBe(401);
    }
    const bad = await env.app.inject({ method: 'POST', url: '/v1/devices/link-requests', payload: { device_name: '', os: 'macos' } });
    expect(bad.statusCode).toBe(400);
  });
});
