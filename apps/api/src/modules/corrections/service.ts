import { randomUUID } from 'node:crypto';
import { hasEntitlement, type CorrectionDTO, type CorrectionValues } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { isTeamManagerOf } from '../authz';
import { currentSubscription } from '../billing/service';
import { emitEvent } from '../webhooks/service';
import { assertWeekUnlocked } from '../timesheets/service';

/** TIME-08: proposals keep the original values; approval applies them without losing history. */

const MAX_ENTRY_MS = 16 * 3600_000;

const SELECT = `
  SELECT c.id, c.user_id, u.display_name AS user_name, c.session_id, c.kind, c.original, c.requested, c.reason, c.status,
         c.reviewed_by, c.reviewed_at, c.review_note, c.created_at
  FROM time_corrections c JOIN users u ON u.id = c.user_id`;

async function get(q: Queryable, id: string): Promise<CorrectionDTO> {
  return (await one<CorrectionDTO>(q, `${SELECT} WHERE c.id = $1`, [id]))!;
}

async function validateValues(deps: Deps, q: Queryable, actor: UserActor, v: CorrectionValues, excludeSessionId: string | null) {
  const start = new Date(v.started_at).getTime();
  const end = new Date(v.ended_at).getTime();
  if (end <= start) throw errors.validation('End must be after start');
  if (end - start > MAX_ENTRY_MS) throw errors.validation('A single entry may not exceed 16 hours');
  if (end > deps.now().getTime() + 60_000) throw errors.validation('Time cannot be in the future');
  if (v.project_id) {
    const p = await one(q, 'SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [v.project_id, actor.organizationId]);
    if (!p) throw errors.validation('Unknown project');
  }
  if (v.task_id) {
    const t = await one(q, 'SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [v.task_id, v.project_id]);
    if (!t) throw errors.validation('Unknown task for this project');
  }
  const overlap = await one(
    q,
    `SELECT 1 FROM work_sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)
       AND started_at < $4 AND COALESCE(ended_at, now()) > $3 LIMIT 1`,
    [actor.userId, excludeSessionId, v.started_at, v.ended_at],
  );
  if (overlap) throw errors.conflict('overlaps_existing_time', 'This time overlaps another recorded session');
}

export async function proposeCorrection(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { session_id?: string; requested: CorrectionValues; reason: string },
  requestId?: string,
): Promise<CorrectionDTO> {
  let original: CorrectionValues | null = null;
  if (input.session_id) {
    const s = await one<{ started_at: string; ended_at: string | null; project_id: string | null; task_id: string | null; state: string }>(
      q,
      `SELECT started_at, ended_at, project_id, task_id, state FROM work_sessions WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
      [input.session_id, actor.userId, actor.organizationId],
    );
    if (!s) throw errors.notFound('Session');
    if (s.state !== 'stopped' || !s.ended_at) throw errors.validation('Stop the session before correcting it');
    original = { started_at: s.started_at, ended_at: s.ended_at, project_id: s.project_id, task_id: s.task_id };
  }
  await validateValues(deps, q, actor, input.requested, input.session_id ?? null);
  await assertWeekUnlocked(deps, q, actor.organizationId, actor.userId, [original?.started_at, input.requested.started_at]);

  const r = await one<{ id: string }>(
    q,
    `INSERT INTO time_corrections (organization_id, user_id, session_id, kind, original, requested, reason, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $2) RETURNING id`,
    [actor.organizationId, actor.userId, input.session_id ?? null, input.session_id ? 'edit' : 'manual_add', original, input.requested, input.reason],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'time_correction.create',
    targetType: 'time_correction',
    targetId: r!.id,
    targetUserId: actor.userId,
    requestId,
  });

  // Plans without an approval workflow apply corrections immediately (still keeping the original).
  const sub = await currentSubscription(q, actor.organizationId, deps.now());
  if (sub.status !== 'trialing' && !hasEntitlement(sub.plan, 'correction_approvals')) {
    await apply(q, r!.id);
    await q.query(`UPDATE time_corrections SET status = 'approved', reviewed_at = now(), review_note = 'Applied automatically' WHERE id = $1`, [r!.id]);
  }
  return get(q, r!.id);
}

async function apply(q: Queryable, id: string) {
  const c = await one<{ organization_id: string; user_id: string; session_id: string | null; kind: string; requested: CorrectionValues }>(
    q,
    'SELECT organization_id, user_id, session_id, kind, requested FROM time_corrections WHERE id = $1',
    [id],
  );
  const v = c!.requested;
  if (c!.kind === 'edit') {
    await q.query(
      `UPDATE work_sessions SET started_at = $2, ended_at = $3, project_id = $4, task_id = $5, corrected = true, updated_at = now()
       WHERE id = $1`,
      [c!.session_id, v.started_at, v.ended_at, v.project_id, v.task_id ?? null],
    );
  } else {
    const sid = randomUUID();
    await q.query(
      `INSERT INTO work_sessions (id, organization_id, user_id, project_id, task_id, state, source, started_at, ended_at, stop_reason, corrected)
       VALUES ($1, $2, $3, $4, $5, 'stopped', 'manual', $6, $7, 'manual', false)`,
      [sid, c!.organization_id, c!.user_id, v.project_id, v.task_id ?? null, v.started_at, v.ended_at],
    );
    await q.query(
      `INSERT INTO session_transitions (session_id, organization_id, state, at, reason) VALUES ($1, $2, 'stopped', $3, 'manual')`,
      [sid, c!.organization_id, v.ended_at],
    );
  }
}

export async function myCorrections(q: Queryable, actor: UserActor): Promise<CorrectionDTO[]> {
  return many<CorrectionDTO>(q, `${SELECT} WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 200`, [actor.userId]);
}

/** Pending corrections the actor may review: members of teams they manage (admins: all). */
export async function pendingForReviewer(q: Queryable, actor: UserActor): Promise<CorrectionDTO[]> {
  return many<CorrectionDTO>(
    q,
    `${SELECT} WHERE c.organization_id = $1 AND c.status = 'pending' AND c.user_id <> $2 AND (
       $3::boolean OR EXISTS (
         SELECT 1 FROM team_memberships m JOIN team_memberships t ON t.team_id = m.team_id
         WHERE m.user_id = $2 AND m.role = 'manager' AND m.valid_to IS NULL AND t.user_id = c.user_id AND t.valid_to IS NULL))
     ORDER BY c.created_at`,
    [actor.organizationId, actor.userId, isAdmin(actor)],
  );
}

export async function reviewCorrection(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  approve: boolean,
  note: string | undefined,
  requestId?: string,
): Promise<CorrectionDTO> {
  const c = await one<{ user_id: string; status: string; session_id: string | null; original: CorrectionValues | null; requested: CorrectionValues }>(
    q,
    'SELECT user_id, status, session_id, original, requested FROM time_corrections WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, actor.organizationId],
  );
  if (!c) throw errors.notFound('Correction');
  if (c.user_id === actor.userId) throw errors.forbidden('You cannot review your own correction');
  if (!isAdmin(actor) && !(await isTeamManagerOf(q, actor.userId, c.user_id))) throw errors.forbidden();
  if (c.status !== 'pending') throw errors.conflict('already_reviewed', 'This correction has already been reviewed');
  if (approve) {
    await validateValues(deps, q, { ...actor, userId: c.user_id }, c.requested, c.session_id);
    await assertWeekUnlocked(deps, q, actor.organizationId, c.user_id, [c.original?.started_at, c.requested.started_at]);
    await apply(q, id);
    await emitEvent(q, actor.organizationId, 'time_correction.approved', {
      correction_id: id,
      user_id: c.user_id,
      started_at: c.requested.started_at,
      ended_at: c.requested.ended_at,
      project_id: c.requested.project_id,
    });
  }
  await q.query(
    `UPDATE time_corrections SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
    [id, approve ? 'approved' : 'rejected', actor.userId, note ?? null],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: approve ? 'time_correction.approve' : 'time_correction.reject',
    targetType: 'time_correction',
    targetId: id,
    targetUserId: c.user_id,
    requestId,
  });
  return get(q, id);
}
