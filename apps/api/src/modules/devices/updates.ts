import type { AgentUpdateMode, AgentUpdateSettings, DeviceUpdateResponse } from '@rd/contracts';
import type { Config } from '../../config';
import type { DeviceActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { audit } from '../audit/service';

/**
 * Desktop app updates (G10). The release workflow signs each update bundle and publishes
 * its `.sig` next to it, under `AGENT_DOWNLOAD_BASE_URL`. The app asks this API with its
 * device credential, so each organization decides how updates arrive; the app installs
 * only bundles signed with the key built into it.
 */

/** "0.10.2" > "0.9.9"; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The update bundle for a platform, by the Tauri bundler's names as GitHub release assets store them. */
export function updateBundleUrl(c: Config['agentDownloads'], target: string, arch: string): string | null {
  if (!c.baseUrl || !c.version) return null;
  const file = (name: string) => `${c.baseUrl}/${encodeURIComponent(name)}`;
  // One universal macOS build serves Apple silicon and Intel.
  if (target === 'darwin' && (arch === 'aarch64' || arch === 'x86_64')) return file('RoundDigital.Track.app.tar.gz');
  // The NSIS installer is the Windows update bundle. MSI installs are updated by IT's own deployment.
  if (target === 'windows' && arch === 'x86_64') return file(`RoundDigital.Track_${c.version}_x64-setup.exe`);
  return null;
}

const signatures = new Map<string, { value: string | null; at: number }>();
const SIGNATURE_TTL_MS = 10 * 60_000;

/** The bundle's `.sig`, cached; null when it can't be fetched (then no update is offered). */
async function signatureFor(url: string, now: number): Promise<string | null> {
  const hit = signatures.get(url);
  if (hit && now - hit.at < SIGNATURE_TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    const res = await fetch(`${url}.sig`, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (res.ok) value = (await res.text()).trim() || null;
  } catch {
    value = null;
  }
  signatures.set(url, { value, at: now });
  return value;
}

/** For tests: forget fetched signatures. */
export function clearSignatureCache() {
  signatures.clear();
}

async function modeOf(q: Queryable, orgId: string): Promise<AgentUpdateMode> {
  return (await one<{ mode: AgentUpdateMode }>(q, 'SELECT agent_update_mode AS mode FROM organizations WHERE id = $1', [orgId]))!.mode;
}

/** What to tell an app asking for an update; null means "nothing to install" (HTTP 204). */
export async function deviceUpdate(
  c: Config['agentDownloads'],
  q: Queryable,
  device: DeviceActor,
  query: { target: string; arch: string; current_version: string },
  now: number,
): Promise<DeviceUpdateResponse | null> {
  const mode = await modeOf(q, device.organizationId);
  if (mode === 'hold' || !c.version || compareVersions(c.version, query.current_version) <= 0) return null;
  const url = updateBundleUrl(c, query.target, query.arch);
  if (!url) return null;
  const signature = await signatureFor(url, now);
  if (!signature) return null;
  return { version: c.version, url, signature, notes: `RoundDigital Track ${c.version}`, pub_date: null, mode };
}

export async function updateSettings(c: Config['agentDownloads'], q: Queryable, orgId: string): Promise<AgentUpdateSettings> {
  const rows = await many<{ version: string; devices: number }>(
    q,
    `SELECT agent_version AS version, count(*)::int AS devices FROM devices
     WHERE organization_id = $1 AND credential_status = 'active' GROUP BY agent_version`,
    [orgId],
  );
  return {
    mode: await modeOf(q, orgId),
    latest_version: c.version,
    versions: rows
      .sort((a, b) => compareVersions(b.version, a.version))
      .map((r) => ({ ...r, current: c.version ? compareVersions(r.version, c.version) >= 0 : true })),
  };
}

export async function setUpdateMode(c: Config['agentDownloads'], q: Queryable, actor: UserActor, mode: AgentUpdateMode, requestId?: string): Promise<AgentUpdateSettings> {
  await q.query('UPDATE organizations SET agent_update_mode = $2 WHERE id = $1', [actor.organizationId, mode]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'agent_updates.mode', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { mode } });
  return updateSettings(c, q, actor.organizationId);
}
