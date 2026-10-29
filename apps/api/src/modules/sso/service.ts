import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import {
  PLANS,
  SSO_TXT_PREFIX,
  SSO_TXT_VALUE_PREFIX,
  type ScimTokenDTO,
  type SsoConnectionDTO,
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

/** Single sign-on through the organization's OpenID Connect provider (slice 6a, G26). */

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
  issuer: string;
  client_id: string;
  client_secret_enc: string;
  status: 'draft' | 'active';
  enforced: boolean;
  jit_provisioning: boolean;
  tested_at: string | null;
}

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
  const c = await one<SsoConnectionDTO>(
    q,
    `SELECT c.issuer, c.client_id, c.status, c.enforced, c.jit_provisioning, c.tested_at, u.display_name AS tested_by_name, c.updated_at
     FROM sso_connections c LEFT JOIN users u ON u.id = c.tested_by WHERE c.organization_id = $1`,
    [orgId],
  );
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
  return { connection: c, domains: domains.map(domainDTO), redirect_uri: redirectUri(deps), scim: { base_url: `${deps.config.webUrl}/scim/v2`, tokens } };
}

/** Saves the provider's details after checking its discovery document; any change needs a new test. */
export async function saveConnection(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  body: { issuer: string; client_id: string; client_secret?: string },
  requestId?: string,
): Promise<void> {
  await gate(deps, q, actor.organizationId);
  const issuer = trimSlash(body.issuer);
  if (!acceptableUrl(issuer, allowLocalHttp(deps))) throw errors.validation('The issuer must be an https:// URL');
  try {
    await discover(fetcher(deps), issuer, deps.now().getTime(), allowLocalHttp(deps), true);
  } catch (e) {
    if (e instanceof OidcError) throw new AppError(400, 'issuer_unreachable', `Couldn't read the provider's configuration: ${e.message}`);
    throw e;
  }
  const before = await one<ConnectionRow>(q, 'SELECT * FROM sso_connections WHERE organization_id = $1', [actor.organizationId]);
  if (!before && !body.client_secret) throw errors.validation('Enter the client secret');
  const secret = body.client_secret ? encryptSecret(deps.config.appEncryptionKey, body.client_secret) : before!.client_secret_enc;
  const changed = !before || before.issuer !== issuer || before.client_id !== body.client_id || Boolean(body.client_secret);
  await q.query(
    `INSERT INTO sso_connections (organization_id, issuer, client_id, client_secret_enc) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id) DO UPDATE SET issuer = $2, client_id = $3, client_secret_enc = $4, updated_at = now(),
       -- New details: back to a draft until someone signs in through them again.
       status = CASE WHEN $5 THEN 'draft' ELSE sso_connections.status END,
       enforced = CASE WHEN $5 THEN false ELSE sso_connections.enforced END,
       tested_at = CASE WHEN $5 THEN NULL ELSE sso_connections.tested_at END,
       tested_by = CASE WHEN $5 THEN NULL ELSE sso_connections.tested_by END`,
    [actor.organizationId, issuer, body.client_id, secret, changed],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'sso.connection_saved', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { issuer, reset: changed } });
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
  const meta = await discover(fetcher(deps), c.issuer, deps.now().getTime(), allowLocalHttp(deps));
  const a = newAuthRequest();
  await q.query(
    `INSERT INTO sso_login_states (state_hash, organization_id, nonce, code_verifier, browser_hash, test_by, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [sha256Hex(a.state), c.organization_id, a.nonce, a.verifier, sha256Hex(p.browser), p.testBy ?? null, p.returnTo ?? null, new Date(deps.now().getTime() + LOGIN_STATE_MINUTES * 60_000).toISOString()],
  );
  await q.query('DELETE FROM sso_login_states WHERE expires_at < $1', [new Date(deps.now().getTime() - 24 * 3600_000).toISOString()]);
  return authorizationUrl(meta, { clientId: c.client_id, redirectUri: redirectUri(deps), state: a.state, nonce: a.nonce, challenge: a.challenge, loginHint: p.loginHint });
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
  nonce: string;
  code_verifier: string;
  browser_hash: string;
  test_by: string | null;
  return_to: string | null;
}

export type CallbackResult = { kind: 'session'; userId: string; orgId: string; returnTo: string } | { kind: 'tested'; orgId: string };

/**
 * The provider sent the browser back. Checks the state belongs to this browser and is
 * unused, trades the code, verifies the ID token, then finds (or, for a verified domain,
 * creates) the person in that organization.
 */
export async function completeSignIn(
  deps: Deps,
  q: Queryable,
  p: { state?: string; code?: string; error?: string; browser?: string },
  requestId?: string,
): Promise<CallbackResult> {
  if (!p.state || !p.browser) throw new SsoFailure('expired');
  // Only the browser that started it can use it, once; another browser can't burn it either.
  const s = await one<StateRow>(
    q,
    `UPDATE sso_login_states SET used_at = $2 WHERE state_hash = $1 AND browser_hash = $3 AND used_at IS NULL AND expires_at > $2
     RETURNING organization_id, nonce, code_verifier, browser_hash, test_by, return_to`,
    [sha256Hex(p.state), deps.now().toISOString(), sha256Hex(p.browser)],
  );
  if (!s) throw new SsoFailure('expired');
  try {
    return await finishSignIn(deps, q, s, p, requestId);
  } catch (e) {
    if (e instanceof SsoFailure) e.test = Boolean(s.test_by);
    throw e;
  }
}

async function finishSignIn(deps: Deps, q: Queryable, s: StateRow, p: { code?: string; error?: string }, requestId?: string): Promise<CallbackResult> {
  if (p.error || !p.code) throw new SsoFailure('provider', p.error);
  const orgId = s.organization_id;
  const c = s.test_by
    ? await one<ConnectionRow>(q, 'SELECT * FROM sso_connections WHERE organization_id = $1', [orgId])
    : await liveConnection(deps, q, orgId);
  if (!c) throw new SsoFailure('provider', 'connection gone');

  let claims;
  try {
    const meta = await discover(fetcher(deps), c.issuer, deps.now().getTime(), allowLocalHttp(deps));
    const idToken = await exchangeCode(fetcher(deps), meta, {
      code: p.code,
      redirectUri: redirectUri(deps),
      verifier: s.code_verifier,
      clientId: c.client_id,
      clientSecret: decryptSecret(deps.config.appEncryptionKey, c.client_secret_enc),
    });
    claims = await verifyIdToken(fetcher(deps), meta, idToken, { audience: c.client_id, nonce: s.nonce, nowMs: deps.now().getTime() });
  } catch (e) {
    if (e instanceof OidcError) {
      await audit(deps.pool, { organizationId: orgId, actor: { kind: 'system' }, action: 'auth.sso_login', result: 'denied', requestId, metadata: { reason: e.message } });
      throw new SsoFailure(e.kind === 'invalid_token' ? 'invalid_token' : 'provider', e.message);
    }
    throw e;
  }
  const email = emailOf(claims);
  let user = await one<{ id: string; status: string; sso_subject: string | null; erased_at: string | null }>(
    q,
    `SELECT id, status, sso_subject, erased_at FROM users WHERE organization_id = $1 AND (sso_subject = $2 OR ($3::text IS NOT NULL AND lower(email) = $3))
     ORDER BY (sso_subject = $2) DESC NULLS LAST LIMIT 1`,
    [orgId, claims.sub, email],
  );

  if (s.test_by) {
    if (!user || user.id !== s.test_by) throw new SsoFailure('wrong_person');
    await bindSubject(q, orgId, user.id, user.sso_subject, claims.sub, requestId);
    await q.query('UPDATE sso_connections SET tested_at = $2, tested_by = $3, updated_at = now() WHERE organization_id = $1', [orgId, deps.now().toISOString(), user.id]);
    await audit(q, { organizationId: orgId, actor: { kind: 'system' }, action: 'sso.tested', targetType: 'user', targetId: user.id, targetUserId: user.id, requestId });
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
      [orgId, email, nameOf(claims, email), claims.sub],
    );
    await audit(q, { organizationId: orgId, actor: { kind: 'system' }, action: 'user.create', targetType: 'user', targetId: created!.id, targetUserId: created!.id, requestId, metadata: { via: 'sso', org_role: 'employee', tracking_enabled: false } });
    user = { id: created!.id, status: 'active', sso_subject: claims.sub, erased_at: null };
  }
  if (user.status !== 'active' || user.erased_at) throw new SsoFailure('deactivated');
  await bindSubject(q, orgId, user.id, user.sso_subject, claims.sub, requestId);
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
