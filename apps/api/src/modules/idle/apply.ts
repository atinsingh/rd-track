import { one, type Queryable } from '../../db/pool';

/**
 * Zeroes idle seconds in this session's buckets that overlap a removed span: a
 * `discard`, or a `reassign` whose correction was approved. Safe to call any number
 * of times; called again after every bucket write so a late bucket can't undo it.
 */
export async function zeroRemovedIdle(q: Queryable, sessionId: string, bucketStart?: string): Promise<void> {
  await q.query(
    `UPDATE activity_buckets b SET idle_seconds = 0
     WHERE b.session_id = $1 AND b.idle_seconds > 0 AND ($2::timestamptz IS NULL OR b.bucket_start = $2)
       AND EXISTS (
         SELECT 1 FROM idle_decisions d
         WHERE d.session_id = b.session_id AND d.status = 'applied' AND d.decision IN ('discard', 'reassign')
           AND d.idle_started_at < b.bucket_start + interval '1 minute' AND d.idle_ended_at > b.bucket_start)`,
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
