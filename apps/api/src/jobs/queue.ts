import type { Pool, Queryable } from '../db/pool';
import { one } from '../db/pool';

/**
 * Postgres-backed job queue (ADR-0002). `enqueue` takes the caller's transaction
 * so a job exists if and only if the work that produced it committed.
 */

export type JobKind =
  | 'ingest.process'
  | 'screenshot.verify'
  | 'screenshot.delete'
  | 'export.generate'
  | 'retention.run'
  | 'seats.snapshot'
  | 'notify.policy_expansion'
  | 'time_off.accrue';

export interface Job {
  id: number;
  organization_id: string | null;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  q: Queryable,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { organizationId?: string | null; runAt?: Date; maxAttempts?: number } = {},
): Promise<number> {
  const r = await one<{ id: number }>(
    q,
    `INSERT INTO jobs (organization_id, kind, payload, run_at, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5) RETURNING id`,
    [opts.organizationId ?? null, kind, payload, opts.runAt?.toISOString() ?? null, opts.maxAttempts ?? 8],
  );
  return r!.id;
}

/** Claims the oldest ready job. Concurrent workers never claim the same job. */
export async function claim(pool: Pool, workerId: string): Promise<Job | null> {
  return one<Job>(
    pool,
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, organization_id, kind, payload, attempts, max_attempts`,
    [workerId],
  );
}

export async function complete(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'done', completed_at = now(), locked_at = NULL WHERE id = $1`, [id]);
}

/** Retries with exponential backoff (2^attempts s, ≤ 1 h); parks as failed after max_attempts. */
export async function fail(pool: Pool, job: Job, error: string): Promise<void> {
  const delaySec = Math.min(3600, 2 ** job.attempts);
  await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
       run_at = now() + make_interval(secs => $2),
       last_error = $3, locked_at = NULL
     WHERE id = $1`,
    [job.id, delaySec, error.slice(0, 2000)],
  );
}

/** Jobs stuck in `running` (crashed worker) go back to the queue. */
export async function requeueStale(pool: Pool, olderThanSec = 600): Promise<number> {
  const r = await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
    [olderThanSec],
  );
  return r.rowCount ?? 0;
}
