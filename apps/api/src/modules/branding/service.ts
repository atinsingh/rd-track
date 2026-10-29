import { randomUUID } from 'node:crypto';
import type { BrandingDTO, DeploymentKeyCreated, DeploymentKeyDTO, LogoUploadResponse } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { SYSTEM_SCOPE, withScope } from '../../db/tenant-scope';
import type { EmailMessage } from '../../email/sender';
import { enrollmentCode, normalizeEnrollmentCode, randomToken, sha256Hex } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertEntitlement } from '../billing/service';

/**
 * G26 (P2): the organization's own logo, and deploying the desktop app with MDM.
 *
 * Logos are private objects like everything else in storage; pages get a short-lived
 * link. Deployment keys only let a managed computer ask for a code by email: the code
 * goes to the person, so holding a key never connects a computer on its own.
 */

const LOGO_UPLOAD_SECONDS = 600;
const LOGO_LINK_SECONDS = 6 * 3600;
const CODE_TTL_MIN = 30;
/** One emailed code per person per minute, however often a computer asks. */
const CODE_REQUEST_GAP_MS = 60_000;

const logoKey = (orgId: string, id: string) => `branding/${orgId}/${id}`;

/** A short-lived link to the logo, or null. */
export async function logoUrl(deps: Pick<Deps, 'store'>, q: Queryable, orgId: string): Promise<string | null> {
  const o = await one<{ logo_key: string | null }>(q, 'SELECT logo_key FROM organizations WHERE id = $1', [orgId]);
  return o?.logo_key ? deps.store.presignGet(o.logo_key, LOGO_LINK_SECONDS) : null;
}

export async function branding(deps: Pick<Deps, 'store'>, q: Queryable, orgId: string): Promise<BrandingDTO> {
  const o = await one<{ logo_updated_at: string | null }>(q, 'SELECT logo_updated_at FROM organizations WHERE id = $1', [orgId]);
  return { logo_url: await logoUrl(deps, q, orgId), logo_updated_at: o!.logo_updated_at };
}

export async function logoUpload(deps: Deps, actor: UserActor, contentType: string): Promise<LogoUploadResponse> {
  const id = randomUUID();
  const put = await deps.store.presignPut(logoKey(actor.organizationId, id), contentType, LOGO_UPLOAD_SECONDS);
  return { upload_id: id, url: put.url, headers: put.headers };
}

/** Uses an uploaded logo: it must be there and small; the previous one is deleted. */
export async function setLogo(deps: Deps, q: Queryable, actor: UserActor, uploadId: string, requestId?: string): Promise<BrandingDTO> {
  const key = logoKey(actor.organizationId, uploadId);
  const head = await deps.store.head(key);
  if (!head) throw errors.validation('The logo has not been uploaded');
  if (head.size > 512 * 1024) {
    await deps.store.delete(key);
    throw errors.validation('The logo is over 512 KB');
  }
  const prev = await one<{ logo_key: string | null }>(q, 'SELECT logo_key FROM organizations WHERE id = $1', [actor.organizationId]);
  await q.query('UPDATE organizations SET logo_key = $2, logo_updated_at = $3 WHERE id = $1', [actor.organizationId, key, deps.now().toISOString()]);
  if (prev?.logo_key && prev.logo_key !== key) await deps.store.delete(prev.logo_key);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'organization.logo_set', targetType: 'organization', targetId: actor.organizationId, requestId });
  return branding(deps, q, actor.organizationId);
}

export async function removeLogo(deps: Deps, q: Queryable, actor: UserActor, requestId?: string): Promise<BrandingDTO> {
  const prev = await one<{ logo_key: string | null }>(q, 'SELECT logo_key FROM organizations WHERE id = $1', [actor.organizationId]);
  await q.query('UPDATE organizations SET logo_key = NULL, logo_updated_at = $2 WHERE id = $1', [actor.organizationId, deps.now().toISOString()]);
  if (prev?.logo_key) await deps.store.delete(prev.logo_key);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'organization.logo_removed', targetType: 'organization', targetId: actor.organizationId, requestId });
  return branding(deps, q, actor.organizationId);
}

// ───────────── deployment keys (Pro) ─────────────

const KEY_SELECT = `
  SELECT k.id, k.name, k.hint, u.display_name AS created_by_name, k.created_at, k.last_used_at, k.revoked_at
  FROM deployment_keys k LEFT JOIN users u ON u.id = k.created_by`;

export async function listDeploymentKeys(deps: Deps, q: Queryable, actor: UserActor): Promise<DeploymentKeyDTO[]> {
  await assertEntitlement(q, actor.organizationId, 'mdm', deps.now(), 'Deploying with MDM');
  return many<DeploymentKeyDTO>(q, `${KEY_SELECT} WHERE k.organization_id = $1 ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`, [actor.organizationId]);
}

export async function createDeploymentKey(deps: Deps, q: Queryable, actor: UserActor, name: string, serverUrl: string, requestId?: string): Promise<DeploymentKeyCreated> {
  await assertEntitlement(q, actor.organizationId, 'mdm', deps.now(), 'Deploying with MDM');
  const key = `rddk_${randomToken(24)}`;
  const r = await one<{ id: string }>(
    q,
    'INSERT INTO deployment_keys (organization_id, name, key_hash, hint, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [actor.organizationId, name, sha256Hex(key), key.slice(-4), actor.userId],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'deployment_key.create', targetType: 'deployment_key', targetId: r!.id, requestId, metadata: { name } });
  const dto = (await one<DeploymentKeyDTO>(q, `${KEY_SELECT} WHERE k.id = $1`, [r!.id]))!;
  return { ...dto, key, server_url: serverUrl };
}

export async function revokeDeploymentKey(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<DeploymentKeyDTO> {
  const r = await q.query('UPDATE deployment_keys SET revoked_at = $3 WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL', [id, actor.organizationId, deps.now().toISOString()]);
  if (!r.rowCount) throw errors.notFound('Deployment key');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'deployment_key.revoke', targetType: 'deployment_key', targetId: id, requestId });
  return (await one<DeploymentKeyDTO>(q, `${KEY_SELECT} WHERE k.id = $1`, [id]))!;
}

/**
 * A managed computer asks for a code for `email`. The answer is the same whether or not
 * the person exists, so a key can't be used to find out who works there; the code goes
 * only to that person's inbox, for someone active with tracking on.
 */
export async function requestEnrollmentCode(deps: Deps, q: Queryable, deploymentKey: string, email: string): Promise<EmailMessage | null> {
  const k = await withScope(SYSTEM_SCOPE, () =>
    one<{ id: string; organization_id: string }>(q, 'SELECT id, organization_id FROM deployment_keys WHERE key_hash = $1 AND revoked_at IS NULL', [sha256Hex(deploymentKey)]),
  );
  if (!k) throw new AppError(401, 'invalid_deployment_key', 'This computer’s deployment key is unknown or was revoked. Ask your IT team.');
  return withScope(k.organization_id, async () => {
    const now = deps.now();
    await q.query('UPDATE deployment_keys SET last_used_at = $2 WHERE id = $1', [k.id, now.toISOString()]);
    try {
      await assertEntitlement(q, k.organization_id, 'mdm', now, 'Deploying with MDM');
    } catch {
      return null;
    }
    const u = await one<{ id: string; email: string; display_name: string; org_name: string }>(
      q,
      `SELECT u.id, u.email, u.display_name, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.organization_id
       WHERE u.organization_id = $1 AND lower(u.email) = lower($2) AND u.status = 'active' AND u.tracking_enabled AND u.erased_at IS NULL`,
      [k.organization_id, email],
    );
    if (!u) return null;
    const recent = await one(q, 'SELECT 1 FROM enrollment_codes WHERE user_id = $1 AND created_by = $1 AND created_at > $2', [
      u.id,
      new Date(now.getTime() - CODE_REQUEST_GAP_MS).toISOString(),
    ]);
    if (recent) return null;
    const code = enrollmentCode();
    await q.query(
      `INSERT INTO enrollment_codes (organization_id, user_id, code_hash, created_by, expires_at, created_at) VALUES ($1, $2, $3, $2, $4, $5)`,
      [k.organization_id, u.id, sha256Hex(normalizeEnrollmentCode(code)), new Date(now.getTime() + CODE_TTL_MIN * 60_000).toISOString(), now.toISOString()],
    );
    await audit(q, {
      organizationId: k.organization_id,
      actor: { kind: 'system' },
      action: 'device.enrollment_code_emailed',
      targetType: 'user',
      targetId: u.id,
      targetUserId: u.id,
      metadata: { deployment_key_id: k.id },
    });
    return {
      to: u.email,
      subject: `Your code to connect this computer to ${u.org_name}`,
      text: [
        `Hi ${u.display_name},`,
        '',
        `Enter this code in RoundDigital Track on the computer you're setting up:`,
        '',
        `    ${code}`,
        '',
        `It works once, in the next ${CODE_TTL_MIN} minutes. Nothing is recorded until you start a session yourself.`,
        '',
        "If you didn't ask for it, you can ignore this email.",
      ].join('\n'),
    };
  });
}
