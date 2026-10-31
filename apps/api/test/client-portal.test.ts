import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, Client, enrollDevice, event, makeOrg, minutes, sendBatch, testEnv, type Org, type TestEnv } from './helpers';

/** Stage 4 F9: a read-only client portal for agencies. */

let env: TestEnv;
let org: Org;
let clientId: string;
let acmeProject: string;
let portal: Client;
const range = 'from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z&tz=UTC';

const linkFrom = () => /\/client\/link\?token=([A-Za-z0-9_-]+)/.exec(env.email.sent.at(-1)!.text)![1]!;
async function accept(token: string, password = 'acme-portal-pass-1') {
  const res = await env.app.inject({ method: 'POST', url: '/v1/client-portal/auth/link', payload: { token, password } });
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, client: raw ? new Client(env.app, (Array.isArray(raw) ? raw[0]! : raw).split(';')[0]!) : null };
}
async function signIn(email: string, password: string) {
  const res = await env.app.inject({ method: 'POST', url: '/v1/client-portal/auth/login', payload: { email, password } });
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, client: raw ? new Client(env.app, (Array.isArray(raw) ? raw[0]! : raw).split(';')[0]!) : null };
}

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.clock.t = new Date('2026-11-04T15:00:00Z').getTime();
  org = await makeOrg(env, 'cp');
  clientId = (await org.admin.post('/v1/admin/clients', { name: 'Acme', currency: 'USD' })).body.id;
  acmeProject = (await org.admin.post('/v1/admin/projects', { name: 'Acme website' })).body.id;
  await org.admin.put(`/v1/admin/projects/${acmeProject}/client`, { client_id: clientId });
  await org.admin.post('/v1/admin/rates/bill', { project_id: acmeProject, user_id: null, amount_cents: 12000, currency: 'USD', effective_from: '2026-01-01' });
  // 30 minutes on Acme's project and 20 on the agency's own.
  const d = await enrollDevice(env, org, 'emp');
  const a = randomUUID();
  const b = randomUUID();
  await sendBatch(env, d, [
    event(d, a, 'session.started.v1', { project_id: acmeProject }, '2026-11-03T14:00:00Z'),
    ...minutes('2026-11-03T14:00:00Z', 30).map((m) => bucket(d, a, m)),
    event(d, a, 'session.stopped.v1', { reason: 'user' }, '2026-11-03T14:30:00Z'),
    event(d, b, 'session.started.v1', { project_id: org.projectId }, '2026-11-03T15:00:00Z'),
    ...minutes('2026-11-03T15:00:00Z', 20).map((m) => bucket(d, b, m)),
  ]);
  await env.drain();
});

describe('inviting a client contact', () => {
  it('is for admins and finance on Pro; the contact chooses their own password', async () => {
    expect((await org.users.emp!.client.post(`/v1/admin/clients/${clientId}/contacts`, { email: 'dana@acme.test', display_name: 'Dana' })).status).toBe(403);
    const r = await org.admin.post(`/v1/admin/clients/${clientId}/contacts`, { email: 'dana@acme.test', display_name: 'Dana Fox' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'invited', display_name: 'Dana Fox' });
    expect(env.email.sent.at(-1)!.to).toBe('dana@acme.test');
    expect((await org.admin.post(`/v1/admin/clients/${clientId}/contacts`, { email: 'DANA@acme.test', display_name: 'Again' })).status).toBe(409);

    const token = linkFrom();
    const info = await env.app.inject({ method: 'GET', url: `/v1/client-portal/auth/link?token=${token}` });
    expect(JSON.parse(info.body)).toMatchObject({ client_name: 'Acme', organization_name: 'cp Inc', first_time: true });
    expect((await accept(token, 'short')).status).toBe(400);
    const ok = await accept(token);
    expect(ok.status).toBe(200);
    portal = ok.client!;
    expect((await accept(token)).status).toBe(400); // single use
    const list = (await org.admin.get(`/v1/admin/clients/${clientId}/contacts`)).body.items;
    expect(list[0].status).toBe('active');

    const std = await makeOrg(env, 'cpstd', 'standard');
    const c = await std.admin.post('/v1/admin/clients', { name: 'X', currency: 'USD' });
    expect(c.status).toBe(402);
  });
});

describe('what the client sees', () => {
  it("their own projects' hours, totals only until the agency shows people", async () => {
    const me = (await portal.get('/v1/client-portal/me')).body;
    expect(me).toMatchObject({ client: { name: 'Acme', show_people: false }, organization: { name: 'cp Inc' } });
    const rep = (await portal.get(`/v1/client-portal/report?${range}`)).body;
    expect(rep.total_seconds).toBe(30 * 60);
    expect(rep.projects.map((p: { name: string }) => p.name)).toEqual(['Acme website']);
    expect(rep.projects[0].people).toBeNull();
    expect(JSON.stringify(rep)).not.toContain('cp emp');

    await org.admin.put(`/v1/admin/clients/${clientId}/portal`, { show_people: true });
    const named = (await portal.get(`/v1/client-portal/report?${range}`)).body;
    expect(named.projects[0].people).toEqual([{ name: 'cp emp', seconds: 30 * 60 }]);
    // Seen from outside the organization: it's in the person's access log.
    const log = (await org.users.emp!.client.get('/v1/me/access-log')).body.items;
    expect(log.map((x: { action: string }) => x.action)).toContain('client_portal.view_hours');
    expect(log.find((x: { action: string }) => x.action === 'client_portal.view_hours').actor_name).toBe('Client · Dana Fox (Acme)');
  });

  it('issued invoices only, and never another client’s', async () => {
    const draft = await org.admin.post('/v1/admin/invoices', { client_id: clientId, period_from: '2026-11-01', period_to: '2026-11-30' });
    expect(draft.status).toBe(201);
    expect((await portal.get('/v1/client-portal/invoices')).body.items).toEqual([]);
    expect((await portal.get(`/v1/client-portal/invoices/${draft.body.id}`)).status).toBe(404);
    await org.admin.post(`/v1/admin/invoices/${draft.body.id}/issue`, { due_date: '2026-11-30' });
    const items = (await portal.get('/v1/client-portal/invoices')).body.items;
    expect(items).toHaveLength(1);
    const inv = (await portal.get(`/v1/client-portal/invoices/${draft.body.id}`)).body;
    expect(inv).toMatchObject({ status: 'issued', client: { name: 'Acme' }, total_cents: 6000 });
    expect(inv).not.toHaveProperty('payment_note');
    const other = await org.admin.post('/v1/admin/clients', { name: 'Other', currency: 'USD' });
    const otherInv = await org.admin.post('/v1/admin/invoices', { client_id: other.body.id, period_from: '2026-11-01', period_to: '2026-11-30' });
    expect((await portal.get(`/v1/client-portal/invoices/${otherInv.body.id}`)).status).toBe(404);
  });

  it('reaches nothing else, and staff sessions reach nothing in the portal', async () => {
    for (const url of ['/v1/me', '/v1/me/insights?' + range, '/v1/admin/clients', `/v1/projects/${acmeProject}/report?${range}`]) {
      expect((await portal.get(url)).status).toBe(401);
    }
    expect((await org.admin.get('/v1/client-portal/me')).status).toBe(401);
    expect((await portal.req('POST', '/v1/client-portal/auth/logout', {})).status).toBe(200);
    expect((await portal.get('/v1/client-portal/me')).status).toBe(401);
  });
});

describe('signing in and losing access', () => {
  it('signs in with the password; a revoked contact is signed out and can’t sign in', async () => {
    expect((await signIn('dana@acme.test', 'wrong-password-1')).status).toBe(401);
    const s = await signIn('Dana@Acme.test', 'acme-portal-pass-1');
    expect(s.status).toBe(200);
    expect((await s.client!.get('/v1/client-portal/me')).status).toBe(200);
    // A new link resets the password and ends other sessions.
    const [contact] = (await org.admin.get(`/v1/admin/clients/${clientId}/contacts`)).body.items;
    await org.admin.post(`/v1/admin/client-contacts/${contact.id}/send-link`);
    const reset = await accept(linkFrom(), 'a-brand-new-pass-2');
    expect(reset.status).toBe(200);
    expect((await s.client!.get('/v1/client-portal/me')).status).toBe(401);

    await org.admin.post(`/v1/admin/client-contacts/${contact.id}/revoke`);
    expect((await reset.client!.get('/v1/client-portal/me')).status).toBe(401);
    expect((await signIn('dana@acme.test', 'a-brand-new-pass-2')).status).toBe(401);
    const audit = (await org.admin.get('/v1/audit-events?action=client_contact.sign_in')).body.items;
    expect(audit[0].actor_name).toBe('Client · Dana Fox (Acme)');
  });
});
