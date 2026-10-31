import { API_TOKEN_EXPIRY_NOTICE_DAYS, type ApiTokenCreated, type ApiTokenDTO, type ApiTokenRequest, type ApiTokenScope, type OrgRole } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, withTx, type Queryable } from '../../db/pool';
import { SYSTEM_SCOPE, withScope } from '../../db/tenant-scope';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { errors } from '../../lib/errors';
import { isAdmin } from '../../context';
import { audit } from '../audit/service';
import { assertEntitlement } from '../billing/service';
import { notify } from '../engine/notify';

/** API tokens (Stage 4 F5): creating, listing, revoking, and signing a call in with one. */

const PREFIX = { organization: 'rdt_org_', personal: 'rdt_pat_' } as const;
const DAY = 24 * 3600_000;

const SELECT = `
  SELECT t.id, t.name, t.kind, t.scopes, t.user_id AS owner_id, u.display_name AS owner_name,
    t.created_at, t.last_used_at, t.expires_at, t.expires_at <= $2 AS expired
  FROM api_tokens t JOIN users u ON u.id = t.user_id`;

const gate = (deps: Deps, q: Queryable, orgId: string) => assertEntitlement(q, orgId, 'api_access', deps.now(), 'The API');

/** Admins see every token in the organization (never the secret); others see their own. */
export async function listTokens(deps: Deps, q: Queryable, actor: UserActor): Promise<ApiTokenDTO[]> {
  return many<ApiTokenDTO>(
    q,
    `${SELECT} WHERE t.organization_id = $1 AND t.revoked_at IS NULL AND ($3::boolean OR t.user_id = $4)
     ORDER BY t.kind, t.created_at DESC`,
    [actor.organizationId, deps.now().toISOString(), isAdmin(actor), actor.userId],
  );
}

export async function createToken(deps: Deps, q: Queryable, actor: UserActor, body: ApiTokenRequest, requestId?: string): Promise<ApiTokenCreated> {
  await gate(deps, q, actor.organizationId);
  if (body.kind === 'organization' && !isAdmin(actor)) throw errors.forbidden('Only org admins create organization tokens');
  const scopes: ApiTokenScope[] = body.kind === 'personal' ? ['read'] : [...new Set(['read', ...(body.scopes ?? [])] as ApiTokenScope[])];
  const token = `${PREFIX[body.kind]}${randomToken(32)}`;
  const expires = new Date(deps.now().getTime() + body.expires_in_days * DAY);
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO api_tokens (organization_id, kind, name, user_id, scopes, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.organizationId, body.kind, body.name, actor.userId, scopes, sha256Hex(token), expires.toISOString()],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'api_token.created',
    targetType: 'api_token',
    targetId: r!.id,
    requestId,
    metadata: { name: body.name, kind: body.kind, scopes, expires_at: expires.toISOString() },
  });
  const dto = await one<ApiTokenDTO>(q, `${SELECT} WHERE t.id = $1`, [r!.id, deps.now().toISOString()]);
  return { ...dto!, token };
}

export async function revokeToken(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<void> {
  const t = await one<{ user_id: string; name: string }>(q, 'SELECT user_id, name FROM api_tokens WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL', [actor.organizationId, id]);
  if (!t) throw errors.notFound('API token');
  if (!isAdmin(actor) && t.user_id !== actor.userId) throw errors.forbidden();
  await q.query('UPDATE api_tokens SET revoked_at = $2, revoked_by = $3 WHERE id = $1', [id, deps.now().toISOString(), actor.userId]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'api_token.revoked', targetType: 'api_token', targetId: id, requestId, metadata: { name: t.name } });
}

/**
 * The caller behind a bearer token: its creator, as they are now (role, status), carrying
 * the token. Unknown, revoked or expired tokens, and creators no longer active, get null;
 * an organization whose plan lost the API gets 'not_entitled'.
 */
export async function authenticateToken(deps: Deps, q: Queryable, raw: string): Promise<UserActor | 'not_entitled' | null> {
  const now = deps.now();
  const t = await one<{
    id: string;
    name: string;
    kind: 'organization' | 'personal';
    scopes: ApiTokenScope[];
    organization_id: string;
    user_id: string;
    org_role: OrgRole;
    display_name: string;
    last_used_at: string | null;
  }>(
    q,
    `SELECT t.id, t.name, t.kind, t.scopes, t.organization_id, t.user_id, u.org_role, u.display_name, t.last_used_at
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > $2 AND u.status = 'active'`,
    [sha256Hex(raw), now.toISOString()],
  );
  if (!t) return null;
  try {
    await gate(deps, q, t.organization_id);
  } catch {
    return 'not_entitled';
  }
  if (!t.last_used_at || now.getTime() - new Date(t.last_used_at).getTime() > 60_000) {
    await q.query('UPDATE api_tokens SET last_used_at = $2 WHERE id = $1', [t.id, now.toISOString()]);
  }
  return {
    kind: 'user',
    userId: t.user_id,
    organizationId: t.organization_id,
    orgRole: t.org_role,
    displayName: t.display_name,
    // No browser session; nothing a token can call touches sessions.
    sessionId: t.id,
    mfaVerified: true,
    token: { id: t.id, name: t.name, kind: t.kind, scopes: t.scopes },
  };
}

/** Hourly: tells each owner once, a week ahead, that a token is about to stop working. */
export async function remindExpiringTokens(deps: Deps): Promise<number> {
  const now = deps.now();
  const soon = await withScope(SYSTEM_SCOPE, () =>
    many<{ id: string; organization_id: string; user_id: string; name: string; kind: string; expires_at: string }>(
      deps.pool,
      `SELECT id, organization_id, user_id, name, kind, expires_at FROM api_tokens
       WHERE revoked_at IS NULL AND expiry_notified_at IS NULL AND expires_at > $1 AND expires_at <= $2`,
      [now.toISOString(), new Date(now.getTime() + API_TOKEN_EXPIRY_NOTICE_DAYS * DAY).toISOString()],
    ),
  );
  for (const t of soon) {
    await withScope(t.organization_id, () =>
      withTx(deps.pool, async (tx) => {
        await notify(tx, t.organization_id, [t.user_id], {
          kind: 'api_token_expiring',
          category: 'security',
          title: (l) => l.t('token.expiring.title', { name: t.name, date: l.day(t.expires_at) }),
          body: (l) => l.t('token.expiring.body'),
          link: t.kind === 'organization' ? '/admin/developers' : '/me/settings#api-tokens',
        });
        await tx.query('UPDATE api_tokens SET expiry_notified_at = $2 WHERE id = $1', [t.id, now.toISOString()]);
      }),
    );
  }
  return soon.length;
}
