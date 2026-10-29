import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSignatureCache, compareVersions } from '../src/modules/devices/updates';
import { deviceReq, enrollDevice, makeOrg, testEnv, type Device, type Org, type TestEnv } from './helpers';

/** G10: desktop app updates, as each organization chooses. */

let env: TestEnv;
let org: Org;
let device: Device;
let releases: Server;
let base: string;
const served: string[] = [];

const check = (target: string, arch: string, current = '0.1.0') => deviceReq(env, device, 'GET', `/v1/device/update?target=${target}&arch=${arch}&current_version=${current}`);

beforeAll(async () => {
  // Stands in for the release assets: only the signatures are fetched by the API.
  releases = createServer((req, res) => {
    served.push(req.url!);
    if (req.url!.endsWith('.app.tar.gz.sig') || req.url!.endsWith('x64-setup.exe.sig')) res.end('dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==\n');
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => releases.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(releases.address() as AddressInfo).port}/agent-v0.2.0`;
  env = await testEnv({ agentDownloads: { baseUrl: base, version: '0.2.0' } });
  org = await makeOrg(env, 'upd');
  device = await enrollDevice(env, org, 'emp');
  clearSignatureCache();
});
afterAll(async () => {
  await env.close();
  releases.close();
});

describe('desktop app updates', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0);
  });

  it('offers the signed bundle to an app that is behind, by default for people to install when it suits them', async () => {
    const mac = await check('darwin', 'aarch64');
    expect(mac.status).toBe(200);
    expect(mac.body).toMatchObject({ version: '0.2.0', mode: 'prompt', url: `${base}/RoundDigital.Track.app.tar.gz`, signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==' });
    expect((await check('windows', 'x86_64')).body.url).toBe(`${base}/RoundDigital.Track_0.2.0_x64-setup.exe`);
    // Up to date, an unknown platform, or no credential: nothing.
    expect((await check('darwin', 'aarch64', '0.2.0')).status).toBe(204);
    expect((await check('linux', 'x86_64')).status).toBe(204);
    expect((await env.app.inject({ method: 'GET', url: '/v1/device/update?target=darwin&arch=aarch64&current_version=0.1.0' })).statusCode).toBe(401);
    // Signatures are cached, not fetched on every check.
    const fetched = served.length;
    await check('darwin', 'x86_64');
    expect(served.length).toBe(fetched);
  });

  it('admins choose automatic installs, or hold updates back', async () => {
    expect((await org.users.manager!.client.put('/v1/admin/agent-updates', { mode: 'auto' })).status).toBe(403);
    const auto = await org.admin.put('/v1/admin/agent-updates', { mode: 'auto' });
    expect(auto.body).toMatchObject({ mode: 'auto', latest_version: '0.2.0', versions: [{ version: '0.1.0', devices: 1, current: false }] });
    expect((await check('darwin', 'aarch64')).body.mode).toBe('auto');
    await org.admin.put('/v1/admin/agent-updates', { mode: 'hold' });
    expect((await check('darwin', 'aarch64')).status).toBe(204);
    expect((await org.admin.get('/v1/audit-events?action=agent_updates.mode')).body.items).toHaveLength(2);
  });

  it('offers nothing when the release has no signature', async () => {
    await org.admin.put('/v1/admin/agent-updates', { mode: 'prompt' });
    clearSignatureCache();
    releases.removeAllListeners('request');
    releases.on('request', (_req, res) => res.writeHead(404).end());
    expect((await check('windows', 'x86_64')).status).toBe(204);
  });
});
