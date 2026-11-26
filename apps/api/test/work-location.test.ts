import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollDevice, event, login, makeOrg, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** Work location (policy `location.capture`): the server-seen IP of a session start and its city. */

let env: TestEnv;
const CITIES: Record<string, { city: string; region: string; country_code: string }> = {
  '203.0.113.10': { city: 'Montreal', region: 'Quebec', country_code: 'CA' },
  '198.51.100.7': { city: 'Lisbon', region: 'Lisbon', country_code: 'PT' },
};

afterAll(() => env.close());
beforeAll(async () => {
  env = await testEnv();
  env.deps.geoip = async (ip) => CITIES[ip] ?? null;
});

/** Starts and stops one session through the agent's event batches, from `ip`. */
async function session(d: Device, ip: string): Promise<string> {
  const sid = randomUUID();
  const events = [event(d, sid, 'session.started.v1', {}, env.clock.iso()), event(d, sid, 'session.stopped.v1', { reason: 'user' }, env.clock.iso(30 * 60_000))];
  const res = await env.app.inject({
    method: 'POST',
    url: '/v1/ingestion/event-batches',
    remoteAddress: ip,
    payload: { batch_id: randomUUID(), sent_at: env.clock.iso(), events },
    headers: { authorization: `Device ${d.credential}` },
  });
  expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['accepted', 'accepted']);
  env.clock.advance(60 * 60_000);
  return sid;
}

describe('work location', () => {
  let org: Org;
  let dev: Device;
  beforeAll(async () => {
    org = await makeOrg(env, 'locco');
    dev = await enrollDevice(env, org, 'emp');
  });

  it('stores nothing while capture is off', async () => {
    await session(dev, '203.0.113.10');
    const me = await login(env.app, 'emp@locco.test');
    const items = (await me.get(`/v1/me/sessions?from=${env.clock.iso(-24 * 3_600_000)}&to=${env.clock.iso()}`)).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ip: null, city: null, country_code: null, location_changed: false });
  });

  it('stores the IP and city when capture is on, and the team report counts a change from the usual city', async () => {
    const pub = await org.admin.put(`/v1/policies/organization/${org.id}`, {
      settings: { location: { capture: true } },
      change_note: 'Work location',
      confirm_expansion: true,
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const from = env.clock.iso();
    await session(dev, '203.0.113.10');
    await session(dev, '203.0.113.10');
    const away = await session(dev, '198.51.100.7');
    const lan = await session(dev, '10.1.2.3');
    const to = env.clock.iso();

    const manager = await login(env.app, 'manager@locco.test');
    const items = (await manager.get(`/v1/users/${org.users.emp!.id}/sessions?from=${from}&to=${to}`)).body.items;
    expect(items.find((s: { id: string }) => s.id === away)).toMatchObject({
      ip: '198.51.100.7',
      city: 'Lisbon',
      region: 'Lisbon',
      country_code: 'PT',
      location_changed: true,
    });
    // A private address is stored without a city and never counts as a change.
    expect(items.find((s: { id: string }) => s.id === lan)).toMatchObject({ ip: '10.1.2.3', city: null, location_changed: false });
    expect(items.filter((s: { location_changed: boolean }) => s.location_changed)).toHaveLength(1);

    const report = await manager.get(`/v1/teams/${org.teamId}/report?from=${from}&to=${to}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const row = report.body.members.find((m: { user_id: string }) => m.user_id === org.users.emp!.id);
    expect(row).toMatchObject({
      location: { city: 'Lisbon', country_code: 'PT' },
      usual_location: { city: 'Montreal', country_code: 'CA' },
      location_changes: 1,
    });
    expect(row).not.toHaveProperty('ip');
  });
});
