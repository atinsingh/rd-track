import type { Deps } from '../../context';
import { many } from '../../db/pool';
import { audit } from '../audit/service';
import { resolveFor } from '../policy/service';
import { deleteScreenshot } from '../screenshots/service';

/**
 * AUD-03: scheduled deletion — screenshots first, then activity/app metadata under
 * each employee's resolved retention, then operational data. Legal holds win.
 */
export async function runRetention(deps: Deps): Promise<Record<string, number>> {
  const { pool } = deps;
  const now = deps.now();
  const counts = { screenshots: 0, abandoned_uploads: 0, activity_buckets: 0, app_usage: 0, data_gaps: 0, ingest_events: 0, exports: 0 };

  // 1. Expired screenshots without a legal hold.
  for (;;) {
    const due = await many<{ id: string }>(
      pool,
      `SELECT s.id FROM screenshots s
       WHERE s.deleted_at IS NULL AND s.retention_after < $1
         AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.user_id = s.user_id AND h.released_at IS NULL
                         AND s.captured_at BETWEEN h.from_at AND h.to_at)
       LIMIT 200`,
      [now.toISOString()],
    );
    if (due.length === 0) break;
    for (const s of due) if (await deleteScreenshot(deps, pool, s.id, 'retention_expired')) counts.screenshots++;
  }

  // Upload intents that were never completed: remove any partial object.
  const abandoned = await many<{ id: string }>(
    pool,
    `SELECT id FROM screenshots WHERE status = 'pending' AND deleted_at IS NULL AND intent_expires_at < $1`,
    [new Date(now.getTime() - 3600_000).toISOString()],
  );
  for (const s of abandoned) if (await deleteScreenshot(deps, pool, s.id, 'upload_abandoned')) counts.abandoned_uploads++;

  // 2. Activity and app metadata per employee.
  const users = await many<{ id: string; organization_id: string }>(pool, 'SELECT id, organization_id FROM users');
  for (const u of users) {
    const { settings } = await resolveFor(deps, pool, u.organization_id, u.id);
    const activityCutoff = new Date(now.getTime() - settings.retention.activity_days * 86_400_000).toISOString();
    const appCutoff = new Date(now.getTime() - settings.retention.app_usage_days * 86_400_000).toISOString();
    const notHeld = (col: string) =>
      `NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.user_id = $1 AND h.released_at IS NULL AND ${col} BETWEEN h.from_at AND h.to_at)`;
    counts.activity_buckets +=
      (await pool.query(`DELETE FROM activity_buckets WHERE user_id = $1 AND bucket_start < $2 AND ${notHeld('bucket_start')}`, [u.id, activityCutoff]))
        .rowCount ?? 0;
    counts.data_gaps +=
      (await pool.query(`DELETE FROM data_gaps WHERE user_id = $1 AND gap_end < $2 AND ${notHeld('gap_start')}`, [u.id, activityCutoff])).rowCount ?? 0;
    counts.app_usage +=
      (await pool.query(`DELETE FROM app_usage WHERE user_id = $1 AND started_at < $2 AND ${notHeld('started_at')}`, [u.id, appCutoff])).rowCount ?? 0;
  }

  // 3. Raw envelopes are operational, not records.
  counts.ingest_events =
    (await pool.query(`DELETE FROM ingest_events WHERE processed_at < $1`, [new Date(now.getTime() - 14 * 86_400_000).toISOString()]))
      .rowCount ?? 0;

  // 4. Expired export files.
  const exports = await many<{ id: string; object_key: string }>(
    pool,
    `SELECT id, object_key FROM export_jobs WHERE status = 'ready' AND expires_at < $1 AND object_key IS NOT NULL`,
    [now.toISOString()],
  );
  for (const e of exports) {
    await deps.store.delete(e.object_key);
    await pool.query(`UPDATE export_jobs SET status = 'expired', object_key = NULL WHERE id = $1`, [e.id]);
    counts.exports++;
  }

  await audit(pool, { organizationId: null, actor: { kind: 'system' }, action: 'retention.run', metadata: counts });
  return counts;
}
