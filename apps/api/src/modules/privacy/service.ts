import { hasEntitlement, type DeletionRequestDTO, type NotificationDTO } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { publish } from '../engine/events';
import { currentSubscription } from '../billing/service';
import { assertInOrg } from '../org/service';
import { resolveFor } from '../policy/service';
import { underLegalHold } from '../screenshots/service';

const REQUEST_SELECT = `
  SELECT d.id, d.requester_id, u.display_name AS requester_name, d.target_type, d.target_id, d.reason, d.status,
         d.reviewer_id, d.created_at, d.completed_at
  FROM deletion_requests d JOIN users u ON u.id = d.requester_id`;

/** SCR-09/10: an employee asks to delete one of their own screenshots. */
export async function requestDeletion(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { target_type: 'screenshot'; target_id: string; reason: string },
  requestId?: string,
): Promise<DeletionRequestDTO> {
  const shot = await one<{ id: string; user_id: string; captured_at: string | null; project_id: string | null }>(
    q,
    `SELECT s.id, s.user_id, s.captured_at, w.project_id FROM screenshots s JOIN work_sessions w ON w.id = s.session_id
     WHERE s.id = $1 AND s.organization_id = $2 AND s.deleted_at IS NULL`,
    [input.target_id, actor.organizationId],
  );
  if (!shot || shot.user_id !== actor.userId) throw errors.notFound('Screenshot');
  const pending = await one(q, `SELECT 1 FROM deletion_requests WHERE target_id = $1 AND status IN ('pending', 'approved')`, [shot.id]);
  if (pending) throw errors.conflict('already_requested', 'Deletion has already been requested for this screenshot');

  const { settings } = await resolveFor(deps, q, actor.organizationId, actor.userId, { projectId: shot.project_id });
  const held = await underLegalHold(q, actor.userId, shot.captured_at);
  const auto = settings.screenshots.employee_deletion === 'self_service' && !held;
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO deletion_requests (organization_id, requester_id, target_type, target_id, reason, status)
     VALUES ($1, $2, 'screenshot', $3, $4, $5) RETURNING id`,
    [actor.organizationId, actor.userId, shot.id, input.reason, auto ? 'approved' : 'pending'],
  );
  if (auto) await enqueue(q, 'screenshot.delete', { screenshot_id: shot.id, request_id: r!.id }, { organizationId: actor.organizationId });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'deletion_request.create',
    targetType: 'screenshot',
    targetId: shot.id,
    targetUserId: actor.userId,
    requestId,
    metadata: { auto_approved: auto, legal_hold: held },
  });
  return (await one<DeletionRequestDTO>(q, `${REQUEST_SELECT} WHERE d.id = $1`, [r!.id]))!;
}

export async function listDeletionRequests(q: Queryable, orgId: string): Promise<DeletionRequestDTO[]> {
  return many<DeletionRequestDTO>(q, `${REQUEST_SELECT} WHERE d.organization_id = $1 ORDER BY d.created_at DESC LIMIT 500`, [orgId]);
}

export async function reviewDeletionRequest(
  q: Queryable,
  actor: UserActor,
  id: string,
  approve: boolean,
  requestId?: string,
): Promise<DeletionRequestDTO> {
  const req = await one<{ id: string; target_id: string; requester_id: string; status: string }>(
    q,
    `SELECT id, target_id, requester_id, status FROM deletion_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, actor.organizationId],
  );
  if (!req) throw errors.notFound('Deletion request');
  if (req.status !== 'pending') throw errors.conflict('already_reviewed', 'This request has already been reviewed');
  if (approve) {
    const shot = await one<{ captured_at: string | null }>(q, 'SELECT captured_at FROM screenshots WHERE id = $1', [req.target_id]);
    if (await underLegalHold(q, req.requester_id, shot?.captured_at ?? null)) {
      throw errors.conflict('legal_hold', 'This screenshot is under legal hold and cannot be deleted now');
    }
  }
  await q.query(`UPDATE deletion_requests SET status = $2, reviewer_id = $3 WHERE id = $1`, [id, approve ? 'approved' : 'rejected', actor.userId]);
  if (approve) await enqueue(q, 'screenshot.delete', { screenshot_id: req.target_id, request_id: id }, { organizationId: actor.organizationId });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: approve ? 'deletion_request.approve' : 'deletion_request.reject',
    targetType: 'screenshot',
    targetId: req.target_id,
    targetUserId: req.requester_id,
    requestId,
  });
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'deletion_request.decided',
    subjectUserId: req.requester_id,
    actorUserId: actor.userId,
    data: { request_id: id, approved: approve, reviewer_name: actor.displayName },
  });
  return (await one<DeletionRequestDTO>(q, `${REQUEST_SELECT} WHERE d.id = $1`, [id]))!;
}

/** AUD-04: narrowly scoped holds (one user, one time range, a stated reason). Pro only. */
export async function createLegalHold(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { user_id: string; from: string; to: string; reason: string },
  requestId?: string,
) {
  const sub = await currentSubscription(q, actor.organizationId, deps.now());
  if (sub.status !== 'trialing' && !hasEntitlement(sub.plan, 'legal_hold')) {
    throw errors.paymentRequired('Legal hold is part of the Pro plan.');
  }
  await assertInOrg(q, actor.organizationId, 'users', input.user_id, 'User');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO legal_holds (organization_id, user_id, from_at, to_at, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [actor.organizationId, input.user_id, input.from, input.to, input.reason, actor.userId],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'legal_hold.create',
    targetType: 'legal_hold',
    targetId: r!.id,
    targetUserId: input.user_id,
    requestId,
    metadata: { from: input.from, to: input.to },
  });
  return { id: r!.id };
}


