import { BlockList, isIP } from 'node:net';
import type { CityResponse } from 'maxmind';
import type { Deps } from '../context';

/** Where a public IP is, from the offline DB-IP City Lite file. Never sent to a third party. */
export interface GeoLocation {
  city: string | null;
  region: string | null;
  country_code: string | null;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything that isn't an IP → null. */
export function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return isIP(v) ? v : null;
}

export function isPrivateIp(ip: string): boolean {
  return PRIVATE.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

type Reader = { get(ip: string): CityResponse | null };

let reader: Promise<Reader | null> | null = null;

function open(path: string | null): Promise<Reader | null> {
  reader ??= (async () => {
    if (!path) {
      console.warn('GEOIP_DB_PATH is not set: work locations are stored without a city');
      return null;
    }
    try {
      const maxmind = (await import('maxmind')).default;
      return await maxmind.open<CityResponse>(path);
    } catch (e) {
      console.warn(`GeoIP database ${path} could not be opened: work locations are stored without a city (${String(e)})`);
      return null;
    }
  })();
  return reader;
}

/** Location of a public IP; null for private/loopback addresses, unknown IPs, or no database. Never throws. */
export async function lookupLocation(deps: Deps, ip: string): Promise<GeoLocation | null> {
  if (isPrivateIp(ip)) return null;
  try {
    if (deps.geoip) return await deps.geoip(ip);
    const r = (await open(deps.config.geoipDbPath))?.get(ip);
    if (!r) return null;
    // DB-IP names some districts ("Montreal (Ville-Marie)"); the city alone keeps one city one place.
    return { city: r.city?.names?.en?.replace(/\s*\(.*\)$/, '') || null, region: r.subdivisions?.[0]?.names?.en ?? null, country_code: r.country?.iso_code ?? null };
  } catch {
    return null;
  }
}
