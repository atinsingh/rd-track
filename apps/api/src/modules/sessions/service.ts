import type { Deps, DeviceActor } from '../../context';
import { one, type Queryable } from '../../db/pool';
import { resolveFor } from '../policy/service';
import { emitEvent } from '../webhooks/service';

/**
 * Work-session lifecycle (system design §6.2, TIME-01..07). Used by both the
 * ingestion path (agent events, possibly replayed or delayed) and the REST
 * endpoints, so every operation is idempotent.
 */

export type LifecycleResult = { ok: true; noop?: boolean } | { ok: false; reason: string };

export interface SessionRow {
  id: string;
  organization_id: string;
  user_id: string;
  device_id: string | null;
  project_id: string | null;
  state: 'active' | 'paused' | 'stopped';
  started_at: string;
  ended_at: string | null;
}

/** How far back a delayed (offline-buffered) event may claim to have happened. */
const MAX_BACKDATE_MS = 8 * 86_400_000;
const CLOCK_SKEW_THRESHOLD_MS = 120_000;

/**
 * Server-normalized time for a device-reported instant (system design §7):
 * corrected by the batch clock offset when skew is large, never in the future,
 * never older than the offline buffer allows.
 */
export function normalizeTime(occurredAt: string, receivedAt: Date, offsetMs: number): Date {
  let t = new Date(occurredAt).getTime();
  if (Math.abs(offsetMs) > CLOCK_SKEW_THRESHOLD_MS) t += offsetMs;
  const max = receivedAt.getTime();
  const min = max - MAX_BACKDATE_MS;
  return new Date(Math.min(max, Math.max(min, t)));
}

export async function getSessionForDevice(q: Queryable, device: DeviceActor, sessionId: string): Promise<SessionRow | null> {
  return one<SessionRow>(
    q,
    `SELECT id, organization_id, user_id, device_id, project_id, state, started_at, ended_at
     FROM work_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND device_id = $4`,
    [sessionId, device.organizationId, device.userId, device.deviceId],
  );
}

async function transition(q: Queryable, s: SessionRow, state: SessionRow['state'], at: Date, reason: string | null) {
  await q.query(
    `INSERT INTO session_transitions (session_id, organization_id, state, at, reason) VALUES ($1, $2, $3, $4, $5)`,
    [s.id, s.organization_id, state, at.toISOString(), reason],
  );
}

export async function startSession(
  deps: Deps,
  q: Queryable,
  device: DeviceActor,
  input: { sessionId: string; projectId?: string | null; taskId?: string | null; at: Date; clientAt?: string; policyRevision: number },
): Promise<LifecycleResult> {
  const existing = await one<SessionRow>(q, 'SELECT * FROM work_sessions WHERE id = $1', [input.sessionId]);
  if (existing) {
    const mine =
      existing.organization_id === device.organizationId && existing.user_id === device.userId && existing.device_id === device.deviceId;
    return mine ? { ok: true, noop: true } : { ok: false, reason: 'session_id_conflict' };
  }

  if (input.projectId) {
    const p = await one(q, `SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'active'`, [
      input.projectId,
      device.organizationId,
    ]);
    if (!p) return { ok: false, reason: 'unknown_project' };
  }
  if (input.taskId) {
    const t = await one(q, 'SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [input.taskId, input.projectId ?? null]);
    if (!t) return { ok: false, reason: 'unknown_task' };
  }

  const { settings } = await resolveFor(deps, q, device.organizationId, device.userId, {
    projectId: input.projectId,
    deviceId: device.deviceId,
  });
  if (settings.session.require_project && !input.projectId) return { ok: false, reason: 'project_required' };

  // Serialize session starts per user so two devices can't both pass the overlap check.
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [device.userId]);
  const open = await one<SessionRow>(
    q,
    `SELECT * FROM work_sessions WHERE user_id = $1 AND state IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1`,
    [device.userId],
  );
  if (open) {
    if (open.device_id === device.deviceId) {
      // The agent runs one session at a time; an open session on the same device was lost
      // (crash without recovery) and ends where the new one starts.
      const end = new Date(Math.max(new Date(open.started_at).getTime(), input.at.getTime()));
      await q.query(
        `UPDATE work_sessions SET state = 'stopped', ended_at = $2, stop_reason = 'superseded', updated_at = now() WHERE id = $1`,
        [open.id, end.toISOString()],
      );
      await transition(q, open, 'stopped', end, 'superseded');
    } else if (!settings.session.allow_overlapping_sessions) {
      return { ok: false, reason: 'overlapping_session' };
    }
  }

  const row = await one<SessionRow>(
    q,
    `INSERT INTO work_sessions
       (id, organization_id, user_id, device_id, project_id, task_id, state, source, started_at, client_started_at, policy_revision)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', 'agent', $7, $8, $9) RETURNING *`,
    [
      input.sessionId,
      device.organizationId,
      device.userId,
      device.deviceId,
      input.projectId ?? null,
      input.taskId ?? null,
      input.at.toISOString(),
      input.clientAt ?? null,
      input.policyRevision,
    ],
  );
  await transition(q, row!, 'active', input.at, 'start');
  await emitEvent(q, device.organizationId, 'session.started', {
    session_id: row!.id,
    user_id: row!.user_id,
    project_id: row!.project_id,
    started_at: row!.started_at,
  });
  return { ok: true };
}

export async function changeSessionState(
  q: Queryable,
  device: DeviceActor,
  sessionId: string,
  to: 'paused' | 'active' | 'stopped',
  at: Date,
  reason: string,
): Promise<LifecycleResult> {
  const s = await getSessionForDevice(q, device, sessionId);
  if (!s) return { ok: false, reason: 'unknown_session' };
  if (s.state === 'stopped') return { ok: true, noop: true }; // late or repeated event after stop
  if (s.state === to) return { ok: true, noop: true };
  if (to === 'active' && s.state !== 'paused') return { ok: true, noop: true };

  const when = new Date(Math.max(at.getTime(), new Date(s.started_at).getTime()));
  if (to === 'stopped') {
    await q.query(
      `UPDATE work_sessions SET state = 'stopped', ended_at = $2, stop_reason = $3, updated_at = now() WHERE id = $1`,
      [s.id, when.toISOString(), reason],
    );
  } else {
    await q.query(`UPDATE work_sessions SET state = $2, updated_at = now() WHERE id = $1`, [s.id, to]);
  }
  await transition(q, s, to, when, reason);
  if (to === 'stopped') {
    await emitEvent(q, s.organization_id, 'session.stopped', {
      session_id: s.id,
      user_id: s.user_id,
      project_id: s.project_id,
      ended_at: when.toISOString(),
    });
  }
  return { ok: true };
}
