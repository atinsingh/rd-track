import type { EventEnvelope } from '@rd/contracts';
import type { Deps } from '../../context';
import { many, one, withTx } from '../../db/pool';
import { zeroRemovedIdle } from '../idle/apply';
import { recordIdleDecision } from '../idle/service';
import { resolveFor } from '../policy/service';

interface PendingRow {
  event_id: string;
  session_id: string;
  event_type: EventEnvelope['event_type'];
  payload: Record<string, unknown>;
}

/**
 * Worker side of ingestion: writes activity buckets, app usage and data gaps.
 * Re-running a job is harmless — every write is keyed by session+minute or event id.
 */
export async function processIngestJob(
  deps: Deps,
  payload: { device_id: string; event_ids: string[]; offset_ms: number },
): Promise<{ applied: number }> {
  return withTx(deps.pool, async (tx) => {
    const rows = await many<PendingRow>(
      tx,
      `SELECT event_id, session_id, event_type, payload FROM ingest_events
       WHERE device_id = $1 AND event_id = ANY($2::uuid[]) AND status = 'pending' FOR UPDATE`,
      [payload.device_id, payload.event_ids],
    );
    const shiftMs = Math.abs(payload.offset_ms) > 120_000 ? payload.offset_ms : 0;
    const minuteShift = Math.round(shiftMs / 60_000) * 60_000;
    const shifted = (iso: unknown, by = shiftMs) => new Date(new Date(String(iso)).getTime() + by).toISOString();

    const sessionCache = new Map<string, { organization_id: string; user_id: string; project_id: string | null }>();
    const policyCache = new Map<string, boolean>();
    let applied = 0;

    for (const r of rows) {
      let s = sessionCache.get(r.session_id);
      if (!s) {
        s = (await one<{ organization_id: string; user_id: string; project_id: string | null }>(
          tx,
          'SELECT organization_id, user_id, project_id FROM work_sessions WHERE id = $1',
          [r.session_id],
        ))!;
        sessionCache.set(r.session_id, s);
      }
      const p = r.payload;
      switch (r.event_type) {
        case 'activity_bucket.v1':
          await tx.query(
            `INSERT INTO activity_buckets
               (session_id, organization_id, user_id, bucket_start, active_seconds, idle_seconds, keyboard_count, mouse_count, data_quality)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (session_id, bucket_start) DO UPDATE SET
               active_seconds = EXCLUDED.active_seconds, idle_seconds = EXCLUDED.idle_seconds,
               keyboard_count = EXCLUDED.keyboard_count, mouse_count = EXCLUDED.mouse_count,
               data_quality = EXCLUDED.data_quality`,
            [
              r.session_id,
              s.organization_id,
              s.user_id,
              shifted(p.bucket_start, minuteShift),
              p.active_seconds,
              p.idle_seconds,
              p.keyboard_count,
              p.mouse_count,
              p.data_quality,
            ],
          );
          // A late bucket inside a span the person already removed stays removed.
          await zeroRemovedIdle(tx, r.session_id, shifted(p.bucket_start, minuteShift));
          break;
        case 'app_usage.v1': {
          // Defence in depth: keep a domain only if the employee's policy allows domains.
          const key = `${s.user_id}:${s.project_id ?? ''}`;
          let domainsAllowed = policyCache.get(key);
          if (domainsAllowed === undefined) {
            const { settings } = await resolveFor(deps, tx, s.organization_id, s.user_id, { projectId: s.project_id });
            domainsAllowed = settings.apps.capture_domains;
            policyCache.set(key, domainsAllowed);
          }
          await tx.query(
            `INSERT INTO app_usage (organization_id, session_id, user_id, event_id, app_identifier, app_name, domain, started_at, duration_seconds)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (event_id) DO NOTHING`,
            [
              s.organization_id,
              r.session_id,
              s.user_id,
              r.event_id,
              p.app_identifier,
              p.app_name,
              domainsAllowed ? ((p.domain as string | undefined) ?? null) : null,
              shifted(p.started_at),
              p.duration_seconds,
            ],
          );
          break;
        }
        case 'data_gap.v1':
          await tx.query(
            `INSERT INTO data_gaps (organization_id, session_id, user_id, event_id, gap_start, gap_end, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING`,
            [s.organization_id, r.session_id, s.user_id, r.event_id, shifted(p.gap_start), shifted(p.gap_end), p.reason],
          );
          break;
        case 'idle.decision.v1':
          await recordIdleDecision(deps, tx, payload.device_id, {
            eventId: r.event_id,
            sessionId: r.session_id,
            startedAt: shifted(p.idle_started_at),
            endedAt: shifted(p.idle_ended_at),
            decision: p.decision as 'keep' | 'discard' | 'reassign',
            projectId: (p.project_id as string | null | undefined) ?? null,
            taskId: (p.task_id as string | null | undefined) ?? null,
          });
          break;
        default:
          break;
      }
      await tx.query(`UPDATE ingest_events SET status = 'applied', processed_at = now() WHERE device_id = $1 AND event_id = $2`, [
        payload.device_id,
        r.event_id,
      ]);
      applied++;
    }
    return { applied };
  });
}
