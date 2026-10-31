import type { SupportGrantDTO, SupportGrantState, SupportSection } from '@rd/contracts';
import type { Deps, PlatformActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { AppError, errors } from '../../lib/errors';
import { audit, listAudit } from '../audit/service';
import { listDevices } from '../devices/service';
import { publish } from '../engine/events';
import { listTeams, listUsers } from '../org/service';
import { listPolicies } from '../policy/service';

/**
 * Support access the tenant approves (slice 5a, G2). An operator asks with a reason and a
 * duration; the tenant's org admins are told and decide. An approved grant runs from
 * approval for the hours asked and either side can end it early. Under it the operator
 * reads configuration only (SUPPORT_SECTIONS) and every read lands in the tenant's audit
 * log, which the tenant sees.
 */

interface GrantRow {
  id: string;
  organization_id: string;
  organization_name: string;
  operator_name: string;
  platform_admin_id: string;
  reason: string;
  requested_hours: number;
  status: 'pending' | 'approved' | 'denied' | 'ended';
  created_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  expires_at: string | null;
  ended_at: string | null;
  ended_by: 'tenant' | 'operator' | null;
}

const SELECT = `
  SELECT g.id, g.organization_id, o.name AS organization_name, pa.display_name AS operator_name, g.platform_admin_id,
         g.reason, g.requested_hours, g.status, g.created_at, g.decided_at, u.display_name AS decided_by_name,
         g.expires_at, g.ended_at, g.ended_by
  FROM support_access_grants g
  JOIN organizations o ON o.id = g.organization_id
  JOIN platform_admins pa ON pa.id = g.platform_admin_id
  LEFT JOIN users u ON u.id = g.approved_by`;

export function grantState(g: Pick<GrantRow, 'status' | 'expires_at'>, nowMs: number): SupportGrantState {
  if (g.status !== 'approved') return g.status;
  return g.expires_at && Date.parse(g.expires_at) > nowMs ? 'active' : 'expired';
}

const toDto = (g: GrantRow, nowMs: number): SupportGrantDTO => {
  const { platform_admin_id: _operator, status, ...rest } = g;
  return { ...rest, state: grantState({ status, expires_at: g.expires_at }, nowMs) };
};

export async function listGrants(deps: Pick<Deps, 'now'>, q: Queryable, f: { orgId?: string; limit?: number } = {}): Promise<SupportGrantDTO[]> {
  const rows = await many<GrantRow>(q, `${SELECT} WHERE ($1::uuid IS NULL OR g.organization_id = $1) ORDER BY g.created_at DESC LIMIT $2`, [
    f.orgId ?? null,
    f.limit ?? 200,
  ]);
  const now = deps.now().getTime();
  return rows.map((r) => toDto(r, now));
}

async function getGrant(q: Queryable, id: string, orgId?: string): Promise<GrantRow> {
  const g = await one<GrantRow>(q, `${SELECT} WHERE g.id = $1 AND ($2::uuid IS NULL OR g.organization_id = $2) FOR UPDATE OF g`, [id, orgId ?? null]);
  if (!g) throw errors.notFound('Support request');
  return g;
}

export async function requestGrant(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  operator: PlatformActor,
  orgId: string,
  body: { reason: string; hours: number },
): Promise<SupportGrantDTO> {
  const org = await one(q, 'SELECT 1 FROM organizations WHERE id = $1', [orgId]);
  if (!org) throw errors.notFound('Organization');
  const open = await one(
    q,
    `SELECT 1 FROM support_access_grants WHERE organization_id = $1 AND platform_admin_id = $2 AND status = 'pending'`,
    [orgId, operator.platformAdminId],
  );
  if (open) throw errors.conflict('support_request_pending', 'You already have a request waiting for this organization');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO support_access_grants (organization_id, platform_admin_id, reason, requested_hours) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, operator.platformAdminId, body.reason, body.hours],
  );
  await audit(q, { organizationId: orgId, actor: operator, action: 'support.requested', targetType: 'support_grant', targetId: r!.id, metadata: { hours: body.hours } });
  const g = await getGrant(q, r!.id);
  await publish(q, {
    organizationId: orgId,
    type: 'support_grant.requested',
    data: { grant_id: g.id, operator_name: g.operator_name, hours: body.hours, reason: body.reason },
  });
  return toDto(g, deps.now().getTime());
}

/** An org admin approves or declines. Approval starts the clock. */
export async function decideGrant(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, id: string, approve: boolean, requestId?: string): Promise<SupportGrantDTO> {
  const g = await getGrant(q, id, actor.organizationId);
  if (g.status !== 'pending') throw errors.conflict('already_decided', 'This request has already been decided');
  const now = deps.now();
  await q.query(
    `UPDATE support_access_grants SET status = $2, approved_by = $3, decided_at = $4, expires_at = $5 WHERE id = $1`,
    [id, approve ? 'approved' : 'denied', actor.userId, now.toISOString(), approve ? new Date(now.getTime() + g.requested_hours * 3600_000).toISOString() : null],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: approve ? 'support.approved' : 'support.denied',
    targetType: 'support_grant',
    targetId: id,
    requestId,
    metadata: { hours: g.requested_hours },
  });
  return toDto(await getGrant(q, id), now.getTime());
}

/** Either side ends an approved grant early. */
export async function endGrant(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  by: { actor: UserActor; side: 'tenant' } | { actor: PlatformActor; side: 'operator' },
  id: string,
  requestId?: string,
): Promise<SupportGrantDTO> {
  const orgScope = by.side === 'tenant' ? by.actor.organizationId : undefined;
  const g = await getGrant(q, id, orgScope);
  if (by.side === 'operator' && g.platform_admin_id !== by.actor.platformAdminId) throw errors.notFound('Support request');
  const now = deps.now();
  const state = grantState(g, now.getTime());
  if (state !== 'active' && state !== 'pending') throw errors.conflict('support_not_active', 'This access has already ended');
  await q.query(`UPDATE support_access_grants SET status = 'ended', ended_at = $2, ended_by = $3 WHERE id = $1`, [id, now.toISOString(), by.side]);
  await audit(q, {
    organizationId: g.organization_id,
    actor: by.actor,
    action: state === 'pending' ? 'support.withdrawn' : 'support.ended',
    targetType: 'support_grant',
    targetId: id,
    requestId,
  });
  return toDto(await getGrant(q, id), now.getTime());
}

async function activeGrant(deps: Pick<Deps, 'now'>, q: Queryable, operator: PlatformActor, orgId: string): Promise<string> {
  const g = await one<{ id: string }>(
    q,
    `SELECT id FROM support_access_grants
     WHERE organization_id = $1 AND platform_admin_id = $2 AND status = 'approved' AND expires_at > $3
     ORDER BY expires_at DESC LIMIT 1`,
    [orgId, operator.platformAdminId, deps.now().toISOString()],
  );
  if (!g) throw new AppError(403, 'support_grant_required', 'This needs support access the organization has approved, and it has to still be running');
  return g.id;
}

/**
 * Configuration reads under an active grant. Never activity, apps, screenshots, time or
 * money: those sections don't exist. Each read is audited in the tenant's log.
 */
export async function supportRead(deps: Pick<Deps, 'now'>, q: Queryable, operator: PlatformActor, orgId: string, section: SupportSection): Promise<unknown> {
  const grantId = await activeGrant(deps, q, operator, orgId);
  await audit(q, { organizationId: orgId, actor: operator, action: 'support.viewed', targetType: 'support_grant', targetId: grantId, metadata: { section } });
  switch (section) {
    case 'people':
      return { items: await listUsers(q, orgId) };
    case 'teams':
      return { items: await listTeams(q, orgId) };
    case 'devices':
      return { items: await listDevices(q, orgId) };
    case 'policies':
      return listPolicies(q, orgId);
    case 'audit':
      return listAudit(q, orgId, { limit: 200 });
  }
}
