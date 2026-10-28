import { one, type Queryable } from '../../db/pool';

/**
 * Applies removed idle spans to this session's buckets: a `discard`, or a `reassign`
 * whose correction was approved. Each bucket loses, per span, the smaller of its
 * measured idle seconds and the span's seconds inside that minute — an edge minute
 * may also hold idle from a neighbouring run, which stays. Always recomputed from the
 * measured value (`idle_seconds_raw`), so it is safe to call any number of times;
 * called again after every bucket write so a late bucket can't undo a removal.
 */
export async function zeroRemovedIdle(q: Queryable, sessionId: string, bucketStart?: string): Promise<void> {
  await q.query(
    `UPDATE activity_buckets b
     SET idle_seconds_raw = r.raw,
         idle_seconds = GREATEST(0, r.raw - LEAST(r.raw, r.removed))
     FROM (
       SELECT b2.session_id, b2.bucket_start, COALESCE(b2.idle_seconds_raw, b2.idle_seconds) AS raw,
              sum(round(EXTRACT(EPOCH FROM (LEAST(d.idle_ended_at, b2.bucket_start + interval '1 minute')
                                            - GREATEST(d.idle_started_at, b2.bucket_start)))))::int AS removed
       FROM activity_buckets b2
       JOIN idle_decisions d ON d.session_id = b2.session_id
         AND d.status = 'applied' AND d.decision IN ('discard', 'reassign')
         AND d.idle_started_at < b2.bucket_start + interval '1 minute' AND d.idle_ended_at > b2.bucket_start
       WHERE b2.session_id = $1 AND ($2::timestamptz IS NULL OR b2.bucket_start = $2)
       GROUP BY b2.session_id, b2.bucket_start, COALESCE(b2.idle_seconds_raw, b2.idle_seconds)
     ) r
     WHERE b.session_id = r.session_id AND b.bucket_start = r.bucket_start`,
    [sessionId, bucketStart ?? null],
  );
}

/** Called when an idle_reassign correction is approved (applied) or rejected. */
export async function settleIdleReassign(q: Queryable, correctionId: string, approved: boolean): Promise<void> {
  const d = await one<{ session_id: string }>(
    q,
    `UPDATE idle_decisions SET status = $2 WHERE correction_id = $1 AND status = 'pending' RETURNING session_id`,
    [correctionId, approved ? 'applied' : 'rejected'],
  );
  if (d && approved) await zeroRemovedIdle(q, d.session_id);
}
