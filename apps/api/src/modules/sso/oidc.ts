import { constants, createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { randomToken } from '../../lib/crypto';

/**
 * The OpenID Connect pieces single sign-on needs (slice 6, G26): discovery, the
 * authorization code flow with PKCE, and ID token verification against the provider's
 * published keys. Node's crypto only; no third-party JOSE library.
 */

export class OidcError extends Error {
  constructor(
    readonly kind: 'provider' | 'invalid_token',
    message: string,
  ) {
    super(message);
  }
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

type Fetch = typeof fetch;
const CACHE_MS = 60 * 60_000;
const SKEW_S = 120;
const cache = new Map<string, { at: number; value: unknown }>();

/** Providers must use HTTPS; plain HTTP is accepted for a local provider outside production. */
export function acceptableUrl(raw: string, allowLocalHttp: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return true;
  return allowLocalHttp && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

async function getJson(fetchImpl: Fetch, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new OidcError('provider', `Could not reach ${url}`);
  }
  if (!res.ok) throw new OidcError('provider', `${url} answered ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new OidcError('provider', `${url} did not return JSON`);
  }
}

export const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** The provider's `.well-known/openid-configuration`, checked and cached for an hour. */
export async function discover(fetchImpl: Fetch, issuer: string, nowMs: number, allowLocalHttp: boolean, fresh = false): Promise<OidcMetadata> {
  const base = trimSlash(issuer);
  const key = `meta:${base}`;
  const hit = cache.get(key);
  if (!fresh && hit && nowMs - hit.at < CACHE_MS) return hit.value as OidcMetadata;
  const m = await getJson(fetchImpl, `${base}/.well-known/openid-configuration`);
  if (typeof m.issuer !== 'string' || trimSlash(m.issuer) !== base) {
    throw new OidcError('provider', `The provider says its issuer is ${String(m.issuer)}, not ${base}`);
  }
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof m[k] !== 'string' || !acceptableUrl(m[k], allowLocalHttp)) throw new OidcError('provider', `The provider's ${k} is missing or not HTTPS`);
  }
  const value = m as unknown as OidcMetadata;
  cache.set(key, { at: nowMs, value });
  return value;
}

async function keys(fetchImpl: Fetch, jwksUri: string, nowMs: number, fresh: boolean): Promise<JsonWebKey[]> {
  const key = `jwks:${jwksUri}`;
  const hit = cache.get(key);
  if (!fresh && hit && nowMs - hit.at < CACHE_MS) return hit.value as JsonWebKey[];
  const body = await getJson(fetchImpl, jwksUri);
  const list = Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : [];
  cache.set(key, { at: nowMs, value: list });
  return list;
}

/** PKCE (RFC 7636) and the values that tie the answer to this request. */
export function newAuthRequest(): { state: string; nonce: string; verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { state: randomToken(), nonce: randomToken(), verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizationUrl(
  m: OidcMetadata,
  p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string },
): string {
  const u = new URL(m.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

/** Trades the code for tokens; client_secret_basic unless the provider only takes client_secret_post. */
export async function exchangeCode(
  fetchImpl: Fetch,
  m: OidcMetadata,
  p: { code: string; redirectUri: string; verifier: string; clientId: string; clientSecret: string },
): Promise<string> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const methods = m.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
    const id = encodeURIComponent(p.clientId);
    const secret = encodeURIComponent(p.clientSecret);
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  } else {
    form.set('client_id', p.clientId);
    form.set('client_secret', p.clientSecret);
  }
  let res: Response;
  try {
    res = await fetchImpl(m.token_endpoint, { method: 'POST', headers, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new OidcError('provider', 'Could not reach the token endpoint');
  }
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (!res.ok || typeof body.id_token !== 'string') {
    throw new OidcError('provider', `The token endpoint answered ${res.status}${typeof body.error === 'string' ? ` (${body.error})` : ''}`);
  }
  return body.id_token;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  upn?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
}

const ALGS: Record<string, { hash: string; kty: 'RSA' | 'EC'; pss?: boolean }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  PS384: { hash: 'sha384', kty: 'RSA', pss: true },
  PS512: { hash: 'sha512', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC' },
  ES384: { hash: 'sha384', kty: 'EC' },
  ES512: { hash: 'sha512', kty: 'EC' },
};

function decodePart<T>(part: string | undefined): T {
  try {
    return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as T;
  } catch {
    throw new OidcError('invalid_token', 'The ID token is malformed');
  }
}

function checkSignature(token: string, jwk: JsonWebKey, alg: string): boolean {
  const spec = ALGS[alg]!;
  const [h, p, s] = token.split('.');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return false;
  }
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s ?? '', 'base64url');
  if (spec.kty === 'EC') return verify(spec.hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (spec.pss) return verify(spec.hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sig);
  return verify(spec.hash, data, key, sig);
}

/**
 * Verifies the ID token's signature with the provider's published keys (fetched again
 * once if the key id is new, for key rotation) and its issuer, audience, expiry and nonce.
 */
export async function verifyIdToken(
  fetchImpl: Fetch,
  m: OidcMetadata,
  token: string,
  expect: { audience: string; nonce: string; nowMs: number },
): Promise<IdClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('invalid_token', 'The ID token is malformed');
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]);
  const alg = header.alg ?? '';
  if (!ALGS[alg]) throw new OidcError('invalid_token', `ID tokens signed with ${alg || 'no algorithm'} are not accepted`);
  const pick = (list: JsonWebKey[]) =>
    list.filter((k) => k.kty === ALGS[alg]!.kty && (k.use === undefined || k.use === 'sig') && (!header.kid || (k as { kid?: string }).kid === header.kid));
  let candidates = pick(await keys(fetchImpl, m.jwks_uri, expect.nowMs, false));
  if (candidates.length === 0) candidates = pick(await keys(fetchImpl, m.jwks_uri, expect.nowMs, true));
  if (!candidates.some((k) => checkSignature(token, k, alg))) throw new OidcError('invalid_token', 'The ID token signature does not verify');

  const c = decodePart<IdClaims>(parts[1]);
  const now = Math.floor(expect.nowMs / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== m.issuer) throw new OidcError('invalid_token', 'The ID token was issued by someone else');
  if (!aud.includes(expect.audience)) throw new OidcError('invalid_token', 'The ID token is for another application');
  if (aud.length > 1 && c.azp !== undefined && c.azp !== expect.audience) throw new OidcError('invalid_token', 'The ID token is for another application');
  if (typeof c.exp !== 'number' || c.exp + SKEW_S < now) throw new OidcError('invalid_token', 'The ID token has expired');
  if (typeof c.iat === 'number' && c.iat - SKEW_S > now) throw new OidcError('invalid_token', 'The ID token is from the future');
  if (c.nonce !== expect.nonce) throw new OidcError('invalid_token', 'The ID token is not for this sign-in');
  if (typeof c.sub !== 'string' || !c.sub) throw new OidcError('invalid_token', 'The ID token has no subject');
  return c;
}

/** The address to match: `email`, else Entra's `preferred_username` / `upn` when it is one. */
export function emailOf(c: IdClaims): string | null {
  if (c.email_verified === false) return null;
  const v = [c.email, c.preferred_username, c.upn].find((x) => typeof x === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  return v ? v.toLowerCase() : null;
}

export function nameOf(c: IdClaims, email: string): string {
  const full = c.name?.trim() || [c.given_name, c.family_name].filter(Boolean).join(' ').trim();
  return (full || email.split('@')[0]!).slice(0, 200);
}

/** Tests only: forget cached discovery documents and keys. */
export function clearOidcCache() {
  cache.clear();
}
