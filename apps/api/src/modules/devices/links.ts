import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { LinkRequestCreated, LinkRequestStatus, LinkRequestView, LinkTokenResponse, linkRequestCreate } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { one, type Queryable } from '../../db/pool';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertCanConnect, issueEnrollmentCode } from './service';

/**
 * Signing in to connect a computer (the browser flow, as desktop apps do it): the app opens
 * a request and shows a short code; the person signs in on the web however their
 * organization signs in (password, two-factor, single sign-on), checks the code matches and
 * confirms; the app, polling with a secret only it holds, then gets an ordinary one-time
 * enrollment code and enrolls with it. Nothing about the person passes through the app.
 */

const LINK_TTL_MIN = 10;
export const LINK_POLL_SECONDS = 2;
/** No 0/O, 1/I/L: easy to compare at a glance. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface LinkRow {
  id: string;
  secret_hash: string;
  user_code: string;
  device_name: string;
  os: LinkRequestView['os'];
  status: 'pending' | 'approved' | 'denied' | 'used';
  organization_id: string | null;
  user_id: string | null;
  approved_by: string | null;
  expires_at: string;
}

function userCode(): string {
  const chars = [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const expired = (r: LinkRow, now: Date) => new Date(r.expires_at).getTime() <= now.getTime();
const gone = () => new AppError(410, 'link_expired', 'This connection request has expired or was already used. Start again from the app.');

async function load(q: Queryable, id: string, lock = false): Promise<LinkRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<LinkRow>(q, `SELECT * FROM device_link_requests WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
}

export async function createLinkRequest(deps: Deps, q: Queryable, input: z.infer<typeof linkRequestCreate>): Promise<LinkRequestCreated> {
  const now = deps.now();
  const secret = randomToken(32);
  const code = userCode();
  const expires = new Date(now.getTime() + LINK_TTL_MIN * 60_000).toISOString();
  // Old requests are kept a day for support questions, then dropped.
  await q.query('DELETE FROM device_link_requests WHERE expires_at < $1', [new Date(now.getTime() - 24 * 3600_000).toISOString()]);
  const row = await one<{ id: string }>(
    q,
    `INSERT INTO device_link_requests (secret_hash, user_code, device_name, os, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [sha256Hex(secret), code, input.device_name, input.os, expires, now.toISOString()],
  );
  return {
    request_id: row!.id,
    user_code: code,
    poll_secret: secret,
    approve_url: `${deps.config.webUrl}/connect?request=${row!.id}`,
    expires_at: expires,
    interval_seconds: LINK_POLL_SECONDS,
  };
}

export async function viewLinkRequest(deps: Deps, q: Queryable, id: string): Promise<LinkRequestView> {
  const r = await load(q, id);
  if (!r) throw errors.notFound('Connection request');
  const status: LinkRequestStatus = r.status === 'pending' && expired(r, deps.now()) ? 'expired' : r.status;
  return { request_id: r.id, device_name: r.device_name, os: r.os, user_code: r.user_code, status, expires_at: new Date(r.expires_at).toISOString() };
}

/**
 * The signed-in person confirms the request for themselves (never for someone else), except a
 * parent in a family (doc 08), who confirms it for one of their children (`childId`).
 */
export async function approveLinkRequest(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  requestId?: string,
  childId?: string,
): Promise<{ status: 'approved' }> {
  const r = await load(q, id, true);
  if (!r) throw errors.notFound('Connection request');
  if (r.status !== 'pending' || expired(r, deps.now())) throw gone();
  const org = await one<{ kind: string }>(q, 'SELECT kind FROM organizations WHERE id = $1', [actor.organizationId]);
  let target = actor.userId;
  if (org?.kind === 'family') {
    if (!childId) throw new AppError(422, 'child_required', 'Choose which child this computer belongs to.');
    if (actor.orgRole !== 'org_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
    const child = await one(q, `SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND org_role = 'child' AND status = 'active'`, [
      childId,
      actor.organizationId,
    ]);
    if (!child) throw errors.notFound('Child');
    target = childId;
  } else if (childId) {
    throw new AppError(422, 'not_family', 'Only a family connects a computer for a child.');
  }
  await assertCanConnect(q, target, target === actor.userId);
  await q.query(
    `UPDATE device_link_requests SET status = 'approved', organization_id = $2, user_id = $3, approved_by = $4, approved_at = $5 WHERE id = $1`,
    [r.id, actor.organizationId, target, actor.userId, deps.now().toISOString()],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'device.link_approved',
    targetType: 'user',
    targetId: target,
    targetUserId: target,
    requestId,
    metadata: { device_name: r.device_name, os: r.os, ...(target !== actor.userId ? { for_child: true } : {}) },
  });
  return { status: 'approved' };
}

export async function denyLinkRequest(deps: Deps, q: Queryable, id: string): Promise<{ status: 'denied' }> {
  const r = await load(q, id, true);
  if (!r) throw errors.notFound('Connection request');
  if (r.status !== 'pending' || expired(r, deps.now())) throw gone();
  await q.query(`UPDATE device_link_requests SET status = 'denied' WHERE id = $1`, [r.id]);
  return { status: 'denied' };
}

/** The app's poll. Once approved it hands out one enrollment code, once. */
export async function collectLinkToken(deps: Deps, q: Queryable, id: string, pollSecret: string): Promise<LinkTokenResponse> {
  const r = await load(q, id, true);
  if (!r || r.secret_hash !== sha256Hex(pollSecret)) throw errors.notFound('Connection request');
  if (r.status === 'denied') throw new AppError(410, 'link_denied', 'The connection was cancelled in the browser.');
  if (r.status === 'used' || expired(r, deps.now())) throw gone();
  if (r.status === 'pending') return { status: 'pending' };
  const used = await one<{ id: string }>(
    q,
    `UPDATE device_link_requests SET status = 'used', used_at = $2 WHERE id = $1 AND status = 'approved' RETURNING id`,
    [r.id, deps.now().toISOString()],
  );
  if (!used) throw gone();
  // A public request, so this runs in the system scope; the code goes to the approver's org, for
  // the approver themselves or (in a family) the child they chose.
  const { code } = await issueEnrollmentCode(deps, q, r.organization_id!, r.user_id!, r.approved_by ?? r.user_id!);
  return { status: 'approved', enrollment_code: code };
}
