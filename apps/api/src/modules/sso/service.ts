import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import {
  PLANS,
  SSO_TXT_PREFIX,
  SSO_TXT_VALUE_PREFIX,
  type ScimTokenDTO,
  type SsoConnectionDTO,
  type SsoConnectionRequest,
  type SsoDiscoverResponse,
  type SsoDomainDTO,
  type SsoErrorCode,
  type SsoSettings,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { existsAnywhere } from '../../db/tenant-scope';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertEntitlement, currentSubscription } from '../billing/service';
import { acceptableUrl, authorizationUrl, discover, emailOf, exchangeCode, nameOf, newAuthRequest, OidcError, trimSlash, verifyIdToken } from './oidc';
import { authnRequestUrl, certificateInfo, newRequestId, parseIdpMetadata, readCertificates, readResponse, SamlError, spFor, type SamlIdp } from './saml';

/** Single sign-on through the organization's OpenID Connect or SAML 2.0 provider (slice 6a, G26). */

const LOGIN_STATE_MINUTES = 10;

export class SsoFailure extends Error {
  /** Set when an admin's test sign-in failed, so they land back on the settings page. */
  test = false;
  constructor(
    readonly code: SsoErrorCode,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

const redirectUri = (deps: Deps) => `${deps.config.webUrl}/v1/auth/sso/callback`;
const allowLocalHttp = (deps: Deps) => deps.config.env !== 'production';
const fetcher = (deps: Deps) => deps.fetch ?? globalThis.fetch;

interface ConnectionRow {
  organization_id: string;
  protocol: 'oidc' | 'saml';
  issuer: string | null;
  client_id: string | null;
  client_secret_enc: string | null;
  saml_idp_entity_id: string | null;
  saml_sso_url: string | null;
  saml_certificates: string | null;
  status: 'draft' | 'active';
  enforced: boolean;
  jit_provisioning: boolean;
  tested_at: string | null;
}

const samlIdp = (c: ConnectionRow): SamlIdp => ({ entityId: c.saml_idp_entity_id!, ssoUrl: c.saml_sso_url!, certificates: readCertificates(c.saml_certificates!) });

const domainDTO = (d: { id: string; domain: string; verified_at: string | null; verification_token: string }): SsoDomainDTO => ({
  id: d.id,
  domain: d.domain,
  verified_at: d.verified_at,
  txt_name: `${SSO_TXT_PREFIX}.${d.domain}`,
  txt_value: `${SSO_TXT_VALUE_PREFIX}${d.verification_token}`,
});

async function entitled(deps: Deps, q: Queryable, orgId: string): Promise<boolean> {
  const sub = await currentSubscription(q, orgId, deps.now());
  return PLANS[sub.status === 'trialing' ? 'pro' : sub.plan].entitlements.includes('sso');
}

const gate = (deps: Deps, q: Queryable, orgId: string) => assertEntitlement(q, orgId, 'sso', deps.now(), 'Single sign-on');

/** The connection people sign in through: switched on, and still on a plan that includes SSO. */
async function liveConnection(deps: Deps, q: Queryable, orgId: string): Promise<ConnectionRow | null> {
  const c = await one<ConnectionRow>(q, `SELECT * FROM sso_connections WHERE organization_id = $1 AND status = 'active'`, [orgId]);
  return c && (await entitled(deps, q, orgId)) ? c : null;
}

/** Whether this person must sign in through the identity provider (admins keep a password way in). */
export async function ssoRequiredFor(deps: Deps, q: Queryable, orgId: string, role: string): Promise<boolean> {
  if (role === 'org_admin' || role === 'super_admin') return false;
  const c = await liveConnection(deps, q, orgId);
  return Boolean(c?.enforced);
}

// ───────────── settings (org admin) ─────────────

export async function ssoSettings(deps: Deps, q: Queryable, orgId: string): Promise<SsoSettings> {
  const row = await one<ConnectionRow & { tested_by_name: string | null; updated_at: string }>(
    q,
    `SELECT c.*, u.display_name AS tested_by_name FROM sso_connections c LEFT JOIN users u ON u.id = c.tested_by WHERE c.organization_id = $1`,
    [orgId],
  );
  const c: SsoConnectionDTO | null = row && {
    protocol: row.protocol,
    issuer: row.issuer,
    client_id: row.client_id,
    saml:
      row.protocol === 'saml'
        ? { entity_id: row.saml_idp_entity_id!, sso_url: row.saml_sso_url!, certificates: readCertificates(row.saml_certificates!).map(certificateInfo) }
        : null,
    status: row.status,
    enforced: row.enforced,
    jit_provisioning: row.jit_provisioning,
    tested_at: row.tested_at,
    tested_by_name: row.tested_by_name,
    updated_at: row.updated_at,
  };
  const domains = await many<{ id: string; domain: string; verified_at: string | null; verification_token: string }>(
    q,
    'SELECT id, domain, verified_at, verification_token FROM sso_domains WHERE organization_id = $1 ORDER BY domain',
    [orgId],
  );
  const tokens = await many<ScimTokenDTO>(
    q,
    `SELECT t.id, t.label, t.created_at, u.display_name AS created_by_name, t.last_used_at
     FROM scim_tokens t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.organization_id = $1 AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
    [orgId],
  );
  const sp = spFor(deps.config.webUrl, orgId);
  return {
    connection: c,
    domains: domains.map(domainDTO),
    redirect_uri: redirectUri(deps),
    saml: { entity_id: sp.entityId, acs_url: sp.acsUrl, metadata_url: sp.metadataUrl },
    scim: { base_url: `${deps.config.webUrl}/scim/v2`, tokens },
  };
}

/** Saves the provider's details (an OpenID Connect provider after reading its discovery document); a new provider needs a new test. */
export async function saveConnection(deps: Deps, q: Queryable, actor: UserActor, body: SsoConnectionRequest, requestId?: string): Promise<void> {
  await gate(deps, q, actor.organizationId);
  const before = await one<ConnectionRow>(q, 'SELECT * FROM sso_connections WHERE organization_id = $1', [actor.organizationId]);
  if (body.protocol === 'saml') return saveSaml(deps, q, actor, body, before, requestId);
  const issuer = trimSlash(body.issuer);
  if (!acceptableUrl(issuer, allowLocalHttp(deps))) throw errors.validation('The issuer must be an https:// URL');
  try {
    await discover(fetcher(deps), issuer, deps.now().getTime(), allowLocalHttp(deps), true);
  } catch (e) {
    if (e instanceof OidcError) throw new AppError(400, 'issuer_unreachable', `Couldn't read the provider's configuration: ${e.message}`);
    throw e;
  }
  const kept = before?.protocol === 'oidc' ? before.client_secret_enc : null;
  if (!kept && !body.client_secret) throw errors.validation('Enter the client secret');
  const secret = body.client_secret ? encryptSecret(deps.config.appEncryptionKey, body.client_secret) : kept!;
  const changed = !before || before.protocol !== 'oidc' || before.issuer !== issuer || before.client_id !== body.client_id || Boolean(body.client_secret);
  await store(q, actor.organizationId, { protocol: 'oidc', issuer, client_id: body.client_id, client_secret_enc: secret }, changed);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.connection_saved', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { protocol: 'oidc', issuer, reset: changed } });
}

async function saveSaml(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  body: Extract<SsoConnectionRequest, { protocol: 'saml' }>,
  before: ConnectionRow | null,
  requestId?: string,
): Promise<void> {
  let idp: SamlIdp;
  try {
    idp = body.metadata_xml ? parseIdpMetadata(body.metadata_xml) : { entityId: body.idp_entity_id!, ssoUrl: body.sso_url!, certificates: readCertificates(body.certificate!) };
  } catch (e) {
    if (e instanceof SamlError) throw new AppError(400, 'saml_metadata_invalid', e.message);
    throw e;
  }
  if (!acceptableUrl(idp.ssoUrl, allowLocalHttp(deps))) throw errors.validation("The provider's sign-in URL must be an https:// URL");
  const certificates = idp.certificates.join('\n');
  // A rolled certificate keeps the connection on (people would be locked out meanwhile); another provider doesn't.
  const changed = !before || before.protocol !== 'saml' || before.saml_idp_entity_id !== idp.entityId || before.saml_sso_url !== idp.ssoUrl;
  await store(q, actor.organizationId, { protocol: 'saml', saml_idp_entity_id: idp.entityId, saml_sso_url: idp.ssoUrl, saml_certificates: certificates }, changed);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'sso.connection_saved',
    targetType: 'organization',
    targetId: actor.organizationId,
    requestId,
    metadata: { protocol: 'saml', entity_id: idp.entityId, certificates_changed: before?.saml_certificates !== certificates, reset: changed },
  });
}

const PROVIDER_FIELDS = ['issuer', 'client_id', 'client_secret_enc', 'saml_idp_entity_id', 'saml_sso_url', 'saml_certificates'] as const;

/** One protocol's details, clearing the other's; new details go back to a draft until someone signs in through them again. */
async function store(q: Queryable, orgId: string, v: { protocol: 'oidc' | 'saml' } & Partial<Record<(typeof PROVIDER_FIELDS)[number], string>>, reset: boolean) {
  const values = PROVIDER_FIELDS.map((f) => v[f] ?? null);
  await q.query(
    `INSERT INTO sso_connections (organization_id, protocol, ${PROVIDER_FIELDS.join(', ')}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id) DO UPDATE SET protocol = $2, ${PROVIDER_FIELDS.map((f, i) => `${f} = $${i + 3}`).join(', ')}, updated_at = now(),
       status = CASE WHEN $9 THEN 'draft' ELSE sso_connections.status END,
       enforced = CASE WHEN $9 THEN false ELSE sso_connections.enforced END,
       tested_at = CASE WHEN $9 THEN NULL ELSE sso_connections.tested_at END,
       tested_by = CASE WHEN $9 THEN NULL ELSE sso_connections.tested_by END`,
    [orgId, v.protocol, ...values, reset],
  );
}

/** Turns single sign-on on (after a test), off, or changes who must use it. */
export async function setSsoOptions(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  body: { active?: boolean; enforced?: boolean; jit_provisioning?: boolean },
  requestId?: string,
): Promise<void> {
  await gate(deps, q, actor.organizationId);
  const c = await one<ConnectionRow>(q, 'SELECT * FROM sso_connections WHERE organization_id = $1', [actor.organizationId]);
  if (!c) throw errors.notFound('SSO connection');
  const active = body.active ?? c.status === 'active';
  if (active && !c.tested_at) throw errors.conflict('sso_untested', 'Sign in through the connection once (Test sign-in) before turning it on');
  const enforced = active && (body.enforced ?? c.enforced);
  if (body.enforced && !active) throw errors.conflict('sso_inactive', 'Turn single sign-on on first');
  const jit = body.jit_provisioning ?? c.jit_provisioning;
  if (body.jit_provisioning) {
    const verified = await one(q, 'SELECT 1 FROM sso_domains WHERE organization_id = $1 AND verified_at IS NOT NULL', [actor.organizationId]);
    if (!verified) throw errors.conflict('no_verified_domain', 'Verify one of your email domains first');
  }
  await q.query(`UPDATE sso_connections SET status = $2, enforced = $3, jit_provisioning = $4, updated_at = now() WHERE organization_id = $1`, [
    actor.organizationId,
    active ? 'active' : 'draft',
    enforced,
    jit,
  ]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.options_changed', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { active, enforced, jit_provisioning: jit } });
}

export async function deleteConnection(q: Queryable, actor: UserActor, requestId?: string): Promise<void> {
  const r = await q.query('DELETE FROM sso_connections WHERE organization_id = $1', [actor.organizationId]);
  if (!r.rowCount) throw errors.notFound('SSO connection');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.connection_deleted', targetType: 'organization', targetId: actor.organizationId, requestId });
}

// ───────────── domains ─────────────

export async function addDomain(deps: Deps, q: Queryable, actor: UserActor, domain: string, requestId?: string): Promise<SsoDomainDTO> {
  await gate(deps, q, actor.organizationId);
  const taken = await existsAnywhere(deps.pool, 'SELECT 1 FROM sso_domains WHERE domain = $1 AND verified_at IS NOT NULL AND organization_id <> $2', [domain, actor.organizationId]);
  if (taken) throw errors.conflict('domain_taken', 'Another organization has already verified this domain');
  const d = await one<{ id: string; domain: string; verified_at: string | null; verification_token: string }>(
    q,
    `INSERT INTO sso_domains (organization_id, domain, verification_token) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, domain) DO UPDATE SET domain = EXCLUDED.domain
     RETURNING id, domain, verified_at, verification_token`,
    [actor.organizationId, domain, randomToken(18)],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.domain_added', targetType: 'sso_domain', targetId: d!.id, requestId, metadata: { domain } });
  return domainDTO(d!);
}

/** Looks for the TXT record now; the domain is verified for this organization only. */
export async function verifyDomain(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<SsoDomainDTO> {
  const d = await one<{ id: string; domain: string; verified_at: string | null; verification_token: string }>(
    q,
    'SELECT id, domain, verified_at, verification_token FROM sso_domains WHERE organization_id = $1 AND id = $2',
    [actor.organizationId, id],
  );
  if (!d) throw errors.notFound('Domain');
  if (d.verified_at) return domainDTO(d);
  const name = `${SSO_TXT_PREFIX}.${d.domain}`;
  const want = `${SSO_TXT_VALUE_PREFIX}${d.verification_token}`;
  let records: string[][] = [];
  try {
    records = await (deps.resolveTxt ?? dnsResolveTxt)(name);
  } catch {
    records = [];
  }
  if (!records.some((chunks) => chunks.join('').trim() === want)) {
    throw errors.conflict('txt_not_found', `No TXT record ${name} with the value ${want} yet. DNS changes can take a while to appear.`);
  }
  const taken = await existsAnywhere(deps.pool, 'SELECT 1 FROM sso_domains WHERE domain = $1 AND verified_at IS NOT NULL', [d.domain]);
  if (taken) throw errors.conflict('domain_taken', 'Another organization has already verified this domain');
  const v = await one<{ id: string; domain: string; verified_at: string | null; verification_token: string }>(
    q,
    'UPDATE sso_domains SET verified_at = $2 WHERE id = $1 RETURNING id, domain, verified_at, verification_token',
    [id, deps.now().toISOString()],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.domain_verified', targetType: 'sso_domain', targetId: id, requestId, metadata: { domain: d.domain } });
  return domainDTO(v!);
}

export async function removeDomain(q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<void> {
  const d = await one<{ domain: string }>(q, 'DELETE FROM sso_domains WHERE organization_id = $1 AND id = $2 RETURNING domain', [actor.organizationId, id]);
  if (!d) throw errors.notFound('Domain');
  const left = await one(q, 'SELECT 1 FROM sso_domains WHERE organization_id = $1 AND verified_at IS NOT NULL', [actor.organizationId]);
  if (!left) await q.query('UPDATE sso_connections SET jit_provisioning = false WHERE organization_id = $1', [actor.organizationId]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.domain_removed', targetType: 'sso_domain', targetId: id, requestId, metadata: { domain: d.domain } });
}

// ───────────── signing in ─────────────

/** Which organization's provider an address signs in through, if any. */
async function routeFor(deps: Deps, q: Queryable, email: string): Promise<{ orgId: string; role: string | null } | null> {
  const u = await one<{ organization_id: string; org_role: string }>(q, 'SELECT organization_id, org_role FROM users WHERE lower(email) = lower($1)', [email]);
  if (u) return (await liveConnection(deps, q, u.organization_id)) ? { orgId: u.organization_id, role: u.org_role } : null;
  // No account yet: a verified domain whose organization creates accounts on first sign-in.
  const domain = email.split('@')[1]!.toLowerCase();
  const d = await one<{ organization_id: string }>(q, 'SELECT organization_id FROM sso_domains WHERE domain = $1 AND verified_at IS NOT NULL', [domain]);
  if (!d) return null;
  const c = await liveConnection(deps, q, d.organization_id);
  return c?.jit_provisioning ? { orgId: d.organization_id, role: null } : null;
}

export async function discoverSignIn(deps: Deps, q: Queryable, email: string): Promise<SsoDiscoverResponse> {
  const r = await routeFor(deps, q, email);
  if (!r) return { method: 'password' };
  const c = (await liveConnection(deps, q, r.orgId))!;
  return { method: 'sso', password_allowed: r.role !== null && (!c.enforced || r.role === 'org_admin' || r.role === 'super_admin') };
}

async function begin(
  deps: Deps,
  q: Queryable,
  c: ConnectionRow,
  p: { browser: string; testBy?: string; returnTo?: string; loginHint?: string },
): Promise<string> {
  const a = newAuthRequest();
  const expires = new Date(deps.now().getTime() + LOGIN_STATE_MINUTES * 60_000).toISOString();
  const insert = (nonce: string | null, verifier: string | null, samlRequestId: string | null) =>
    q.query(
      `INSERT INTO sso_login_states (state_hash, organization_id, nonce, code_verifier, saml_request_id, browser_hash, test_by, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [sha256Hex(a.state), c.organization_id, nonce, verifier, samlRequestId, sha256Hex(p.browser), p.testBy ?? null, p.returnTo ?? null, expires],
    );
  await q.query('DELETE FROM sso_login_states WHERE expires_at < $1', [new Date(deps.now().getTime() - 24 * 3600_000).toISOString()]);
  if (c.protocol === 'saml') {
    // The state travels as RelayState and comes back with the provider's answer.
    const id = newRequestId();
    await insert(null, null, id);
    return authnRequestUrl(spFor(deps.config.webUrl, c.organization_id), samlIdp(c), id, a.state);
  }
  const meta = await discover(fetcher(deps), c.issuer!, deps.now().getTime(), allowLocalHttp(deps));
  await insert(a.nonce, a.verifier, null);
  return authorizationUrl(meta, { clientId: c.client_id!, redirectUri: redirectUri(deps), state: a.state, nonce: a.nonce, challenge: a.challenge, loginHint: p.loginHint });
}

/** The identity provider's sign-in URL for this address (409 sso_not_available when it signs in with a password). */
export async function startSignIn(deps: Deps, q: Queryable, email: string, browser: string, returnTo?: string): Promise<string> {
  const r = await routeFor(deps, q, email);
  if (!r) throw errors.conflict('sso_not_available', 'This address signs in with a password');
  const c = (await liveConnection(deps, q, r.orgId))!;
  return begin(deps, q, c, { browser, returnTo, loginHint: email });
}

/** An admin signs in through a draft (or live) connection to prove it works. */
export async function startTest(deps: Deps, q: Queryable, actor: UserActor, browser: string): Promise<string> {
  await gate(deps, q, actor.organizationId);
  const c = await one<ConnectionRow>(q, 'SELECT * FROM sso_connections WHERE organization_id = $1', [actor.organizationId]);
  if (!c) throw errors.notFound('SSO connection');
  const email = await one<{ email: string }>(q, 'SELECT email FROM users WHERE id = $1', [actor.userId]);
  try {
    return await begin(deps, q, c, { browser, testBy: actor.userId, loginHint: email?.email });
  } catch (e) {
    if (e instanceof OidcError) throw new AppError(400, 'issuer_unreachable', `Couldn't read the provider's configuration: ${e.message}`);
    throw e;
  }
}

interface StateRow {
  organization_id: string;
  nonce: string | null;
  code_verifier: string | null;
  saml_request_id: string | null;
  saml_result: SamlResult | null;
  browser_hash: string;
  test_by: string | null;
  return_to: string | null;
}

/** Who the provider vouched for, whichever protocol it spoke. */
interface Identity {
  sub: string;
  email: string | null;
  name: string | null;
}

/** What the provider's posted SAML answer said, kept until the browser comes back. */
type SamlResult = { ok: true; identity: Identity } | { ok: false; code: SsoErrorCode; reason: string };

const STATE_COLUMNS = 'organization_id, nonce, code_verifier, saml_request_id, saml_result, browser_hash, test_by, return_to';

export type CallbackResult = { kind: 'session'; userId: string; orgId: string; returnTo: string } | { kind: 'tested'; orgId: string };

/** Consumes the sign-in in flight: only the browser that started it can use it, once; another browser can't burn it either. */
async function consume(deps: Deps, q: Queryable, state: string | undefined, browser: string | undefined, extra = ''): Promise<StateRow> {
  if (!state || !browser) throw new SsoFailure('expired');
  const s = await one<StateRow>(
    q,
    `UPDATE sso_login_states SET used_at = $2 WHERE state_hash = $1 AND browser_hash = $3 AND used_at IS NULL AND expires_at > $2 ${extra}
     RETURNING ${STATE_COLUMNS}`,
    [sha256Hex(state), deps.now().toISOString(), sha256Hex(browser)],
  );
  if (!s) throw new SsoFailure('expired');
  return s;
}

/** Marks a failure as a test sign-in's, so the admin lands back on the settings page. */
async function asTest<T>(s: StateRow, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SsoFailure) e.test = Boolean(s.test_by);
    throw e;
  }
}

/** The connection a sign-in in flight goes through: the stored one for a test, otherwise only while it's live. */
const connectionFor = async (deps: Deps, q: Queryable, s: StateRow) =>
  s.test_by ? one<ConnectionRow>(q, 'SELECT * FROM sso_connections WHERE organization_id = $1', [s.organization_id]) : liveConnection(deps, q, s.organization_id);

const denied = (deps: Deps, orgId: string, reason: string, requestId?: string) =>
  audit(deps.pool, { organizationId: orgId, actor: { kind: 'system' }, action: 'auth.sso_login', result: 'denied', requestId, metadata: { reason } });

/**
 * The OpenID Connect provider sent the browser back. Checks the state belongs to this
 * browser and is unused, trades the code, verifies the ID token, then finds (or, for a
 * verified domain, creates) the person in that organization.
 */
export async function completeSignIn(
  deps: Deps,
  q: Queryable,
  p: { state?: string; code?: string; error?: string; browser?: string },
  requestId?: string,
): Promise<CallbackResult> {
  const s = await consume(deps, q, p.state, p.browser, 'AND saml_request_id IS NULL');
  return asTest(s, () => finishOidc(deps, q, s, p, requestId));
}

async function finishOidc(deps: Deps, q: Queryable, s: StateRow, p: { code?: string; error?: string }, requestId?: string): Promise<CallbackResult> {
  if (p.error || !p.code) throw new SsoFailure('provider', p.error);
  const c = await connectionFor(deps, q, s);
  if (!c || c.protocol !== 'oidc') throw new SsoFailure('provider', 'connection gone');

  let claims;
  try {
    const meta = await discover(fetcher(deps), c.issuer!, deps.now().getTime(), allowLocalHttp(deps));
    const idToken = await exchangeCode(fetcher(deps), meta, {
      code: p.code,
      redirectUri: redirectUri(deps),
      verifier: s.code_verifier!,
      clientId: c.client_id!,
      clientSecret: decryptSecret(deps.config.appEncryptionKey, c.client_secret_enc!),
    });
    claims = await verifyIdToken(fetcher(deps), meta, idToken, { audience: c.client_id!, nonce: s.nonce!, nowMs: deps.now().getTime() });
  } catch (e) {
    if (e instanceof OidcError) {
      await denied(deps, s.organization_id, e.message, requestId);
      throw new SsoFailure(e.kind === 'invalid_token' ? 'invalid_token' : 'provider', e.message);
    }
    throw e;
  }
  const email = emailOf(claims);
  return signInAs(deps, q, s, c, { sub: claims.sub, email, name: email ? nameOf(claims, email) : null }, requestId);
}

/**
 * The SAML provider posted its answer (cross-site, so without the browser cookie). Checks
 * it answers the request for this RelayState and keeps the outcome for that browser to
 * collect; the state is only used up when it does. Returns false when there's no such
 * sign-in in flight (expired, used, or started at the provider rather than in Track).
 */
export async function receiveSamlResponse(
  deps: Deps,
  q: Queryable,
  orgId: string,
  p: { relayState?: string; samlResponse?: string },
  requestId?: string,
): Promise<boolean> {
  if (!p.relayState || !p.samlResponse) return false;
  const s = await one<StateRow>(
    q,
    `SELECT ${STATE_COLUMNS} FROM sso_login_states
     WHERE state_hash = $1 AND organization_id = $2 AND saml_request_id IS NOT NULL AND saml_result IS NULL AND used_at IS NULL AND expires_at > $3
     FOR UPDATE`,
    [sha256Hex(p.relayState), orgId, deps.now().toISOString()],
  );
  if (!s) return false;
  const c = await connectionFor(deps, q, s);
  let result: SamlResult;
  if (!c || c.protocol !== 'saml') result = { ok: false, code: 'provider', reason: 'connection gone' };
  else {
    try {
      result = { ok: true, identity: await readResponse(spFor(deps.config.webUrl, orgId), samlIdp(c), s.saml_request_id!, p.samlResponse) };
    } catch (e) {
      if (!(e instanceof SamlError)) throw e;
      // A provider that refused the sign-in answers with a status instead of an assertion.
      result = { ok: false, code: e.refused ? 'provider' : 'invalid_token', reason: e.message.slice(0, 300) };
      await denied(deps, orgId, result.reason, requestId);
    }
  }
  await q.query('UPDATE sso_login_states SET saml_result = $2, saml_received_at = $3 WHERE state_hash = $1', [sha256Hex(p.relayState), JSON.stringify(result), deps.now().toISOString()]);
  return true;
}

/** The browser that started a SAML sign-in comes back (same-site, with its cookie) for the outcome. */
export async function completeSamlSignIn(deps: Deps, q: Queryable, p: { state?: string; browser?: string }, requestId?: string): Promise<CallbackResult> {
  const s = await consume(deps, q, p.state, p.browser, 'AND saml_result IS NOT NULL');
  return asTest(s, async () => {
    const r = s.saml_result!;
    if (!r.ok) throw new SsoFailure(r.code, r.reason);
    const c = await connectionFor(deps, q, s);
    if (!c || c.protocol !== 'saml') throw new SsoFailure('provider', 'connection gone');
    return signInAs(deps, q, s, c, r.identity, requestId);
  });
}

/** Finds (or, for a verified domain, creates) the person the provider vouched for, or finishes an admin's test. */
async function signInAs(deps: Deps, q: Queryable, s: StateRow, c: ConnectionRow, who: Identity, requestId?: string): Promise<CallbackResult> {
  const orgId = s.organization_id;
  const { sub, email } = who;
  let user = await one<{ id: string; status: string; sso_subject: string | null; erased_at: string | null }>(
    q,
    `SELECT id, status, sso_subject, erased_at FROM users WHERE organization_id = $1 AND (sso_subject = $2 OR ($3::text IS NOT NULL AND lower(email) = $3))
     ORDER BY (sso_subject = $2) DESC NULLS LAST LIMIT 1`,
    [orgId, sub, email],
  );

  if (s.test_by) {
    if (!user || user.id !== s.test_by) throw new SsoFailure('wrong_person');
    await bindSubject(q, orgId, user.id, user.sso_subject, sub, requestId);
    await q.query('UPDATE sso_connections SET tested_at = $2, tested_by = $3, updated_at = now() WHERE organization_id = $1', [orgId, deps.now().toISOString(), user.id]);
    await audit(q, { organizationId: orgId, actor: { kind: 'system' }, action: 'sso.tested', targetType: 'user', targetId: user.id, targetUserId: user.id, requestId, metadata: { protocol: c.protocol } });
    return { kind: 'tested', orgId };
  }

  if (!user) {
    if (!email || !c.jit_provisioning) throw new SsoFailure('no_account');
    const verified = await one(q, 'SELECT 1 FROM sso_domains WHERE organization_id = $1 AND domain = $2 AND verified_at IS NOT NULL', [orgId, email.split('@')[1]]);
    const elsewhere = await one(q, 'SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (!verified || elsewhere) throw new SsoFailure('no_account');
    // Just-in-time: an employee with tracking off, so no seat is used until an admin turns it on.
    const created = await one<{ id: string }>(
      q,
      `INSERT INTO users (organization_id, email, display_name, org_role, tracking_enabled, sso_subject) VALUES ($1, $2, $3, 'employee', false, $4) RETURNING id`,
      [orgId, email, who.name ?? email.split('@')[0]!, sub],
    );
    await audit(q, { organizationId: orgId, actor: { kind: 'system' }, action: 'user.create', targetType: 'user', targetId: created!.id, targetUserId: created!.id, requestId, metadata: { via: 'sso', org_role: 'employee', tracking_enabled: false } });
    user = { id: created!.id, status: 'active', sso_subject: sub, erased_at: null };
  }
  if (user.status !== 'active' || user.erased_at) throw new SsoFailure('deactivated');
  await bindSubject(q, orgId, user.id, user.sso_subject, sub, requestId);
  return { kind: 'session', userId: user.id, orgId, returnTo: s.return_to ?? '/' };
}

async function bindSubject(q: Queryable, orgId: string, userId: string, current: string | null, sub: string, requestId?: string) {
  if (current === sub) return;
  await q.query('UPDATE users SET sso_subject = NULL WHERE organization_id = $1 AND sso_subject = $2 AND id <> $3', [orgId, sub, userId]);
  await q.query('UPDATE users SET sso_subject = $2 WHERE id = $1', [userId, sub]);
  if (current) await audit(q, { organizationId: orgId, actor: { kind: 'system' }, action: 'auth.sso_subject_changed', targetType: 'user', targetId: userId, targetUserId: userId, requestId });
}

/** Whether people in this organization can sign in through its identity provider right now. */
export async function ssoLive(deps: Deps, q: Queryable, orgId: string): Promise<boolean> {
  return Boolean(await liveConnection(deps, q, orgId));
}
