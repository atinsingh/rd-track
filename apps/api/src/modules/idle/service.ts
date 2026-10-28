import type { IdleAdjustmentDTO } from '@rd/contracts';
import type { Deps, DeviceActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { audit } from '../audit/service';
import { proposeIdleReassign } from '../corrections/service';
import { assertWeekUnlocked } from '../timesheets/service';
import { zeroRemovedIdle } from './apply';

/**
 * Stage 4 F1 — the person's answer to "you were away for N min" (migration 008).
 * Runs in the ingestion worker, after the buckets that came before it.
 */

export interface IdleDecisionInput {
  eventId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  decision: 'keep' | 'discard' | 'reassign';
  projectId: string | null;
  taskId: string | null;
}

export async function recordIdleDecision(deps: Deps, q: Queryable, deviceId: string, input: IdleDecisionInput): Promise<void> {
  const s = await one<{ organization_id: string; user_id: string; project_id: string | null; task_id: string | null }>(
    q,
    'SELECT organization_id, user_id, project_id, task_id FROM work_sessions WHERE id = $1',
    [input.sessionId],
  );
  if (!s) return;
  const device: DeviceActor = { kind: 'device', deviceId, userId: s.user_id, organizationId: s.organization_id };

  let status: 'applied' | 'pending' | 'rejected' = input.decision === 'reassign' ? 'pending' : 'applied';
  let reason: string | null = null;
  if (input.decision !== 'keep') {
    try {
      await assertWeekUnlocked(deps, q, s.organization_id, s.user_id, [input.startedAt]);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'timesheet_locked') throw e;
      status = 'rejected';
      reason = 'week_locked';
    }
  }
  if (status === 'pending') {
    const p = await one(q, `SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'active'`, [
      input.projectId,
      s.organization_id,
    ]);
    const t = input.taskId ? await one(q, 'SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [input.taskId, input.projectId]) : true;
    if (!p || !t) {
      status = 'rejected';
      reason = 'unknown_project';
    }
  }

  const row = await one<{ id: string }>(
    q,
    `INSERT INTO idle_decisions
       (organization_id, user_id, session_id, device_id, event_id, idle_started_at, idle_ended_at, decision, project_id, task_id, status, status_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [
      s.organization_id, s.user_id, input.sessionId, deviceId, input.eventId, input.startedAt, input.endedAt,
      input.decision, input.projectId, input.taskId, status, reason,
    ],
  );
  if (!row) return; // replayed event

  await audit(q, {
    organizationId: s.organization_id,
    actor: device,
    action: `idle.${input.decision}`,
    targetType: 'work_session',
    targetId: input.sessionId,
    targetUserId: s.user_id,
    result: status === 'rejected' ? 'denied' : 'success',
    metadata: { seconds: spanSeconds(input.startedAt, input.endedAt), ...(reason ? { reason } : {}) },
  });

  if (status === 'applied' && input.decision === 'discard') await zeroRemovedIdle(q, input.sessionId);
  if (status === 'pending') {
    await proposeIdleReassign(deps, q, {
      organizationId: s.organization_id,
      userId: s.user_id,
      sessionId: input.sessionId,
      decisionId: row.id,
      original: { started_at: input.startedAt, ended_at: input.endedAt, project_id: s.project_id, task_id: s.task_id },
      requested: { started_at: input.startedAt, ended_at: input.endedAt, project_id: input.projectId, task_id: input.taskId },
    });
  }
}

function spanSeconds(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
}

export async function idleAdjustmentsFor(q: Queryable, sessionIds: string[]): Promise<Map<string, IdleAdjustmentDTO[]>> {
  const rows = await many<IdleAdjustmentDTO & { session_id: string }>(
    q,
    `SELECT d.id, d.session_id, d.idle_started_at, d.idle_ended_at,
            EXTRACT(EPOCH FROM (d.idle_ended_at - d.idle_started_at))::int AS seconds,
            d.decision, d.status, d.status_reason, p.name AS project_name
     FROM idle_decisions d LEFT JOIN projects p ON p.id = d.project_id
     WHERE d.session_id = ANY($1::uuid[]) AND d.decision <> 'keep'
     ORDER BY d.idle_started_at`,
    [sessionIds],
  );
  const m = new Map<string, IdleAdjustmentDTO[]>();
  for (const { session_id, ...r } of rows) m.set(session_id, [...(m.get(session_id) ?? []), r]);
  return m;
}
