import {
  eventEnvelopeSchema,
  isLifecycleEvent,
  type EventBatch,
  type EventBatchResponse,
  type EventEnvelope,
  type EventResult,
} from '@rd/contracts';
import type { Deps, DeviceActor } from '../../context';
import { one, withTx, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { assertLicensedForTracking } from '../billing/service';
import { changeSessionState, getSessionForDevice, normalizeTime, startSession } from '../sessions/service';

/**
 * Batch ingestion (system design §5.3). One transaction: store raw envelopes
 * idempotently, apply lifecycle events inline, validate the rest against their
 * session, enqueue one processing job — then acknowledge.
 */
export async function ingestBatch(deps: Deps, device: DeviceActor, batch: EventBatch, requestId?: string): Promise<EventBatchResponse> {
  const receivedAt = deps.now();
  const offsetMs = receivedAt.getTime() - new Date(batch.sent_at).getTime();

  return withTx(deps.pool, async (tx) => {
    await assertLicensedForTracking(tx, device.organizationId, device.userId, receivedAt);
    const results = new Map<number, EventResult>();
    const valid: { index: number; e: EventEnvelope }[] = [];

    batch.events.forEach((raw, index) => {
      const eventId =
        raw && typeof raw === 'object' && typeof (raw as { event_id?: unknown }).event_id === 'string'
          ? ((raw as { event_id: string }).event_id)
          : null;
      const parsed = eventEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        // Only the failing paths are reported; payload values are never echoed or logged.
        const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 5).join(', ');
        results.set(index, { event_id: eventId, status: 'rejected', reason: `invalid_event${paths ? `: ${paths}` : ''}` });
        return;
      }
      const e = parsed.data;
      if (e.device_id !== device.deviceId || e.organization_id !== device.organizationId) {
        results.set(index, { event_id: e.event_id, status: 'rejected', reason: 'device_mismatch' });
        return;
      }
      valid.push({ index, e });
    });

    // Apply in device order so start → buckets → stop works within one batch.
    valid.sort((a, b) => a.e.sequence - b.e.sequence);
    const pending: string[] = [];
    let maxSeq = -1;
    let minSeq = Number.POSITIVE_INFINITY;

    for (const { index, e } of valid) {
      maxSeq = Math.max(maxSeq, e.sequence);
      minSeq = Math.min(minSeq, e.sequence);
      const inserted = await one(
        tx,
        `INSERT INTO ingest_events (device_id, event_id, organization_id, session_id, event_type, sequence, occurred_at, received_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (device_id, event_id) DO NOTHING RETURNING event_id`,
        [device.deviceId, e.event_id, device.organizationId, e.session_id, e.event_type, e.sequence, e.occurred_at, receivedAt.toISOString(), e.payload],
      );
      if (!inserted) {
        results.set(index, { event_id: e.event_id, status: 'duplicate' });
        continue;
      }
      const verdict = await applyOrValidate(deps, tx, device, e, receivedAt, offsetMs);
      if (verdict.ok) {
        results.set(index, { event_id: e.event_id, status: 'accepted' });
        if (verdict.deferred) pending.push(e.event_id);
      } else {
        await tx.query(
          `UPDATE ingest_events SET status = 'rejected', reason = $3, processed_at = now() WHERE device_id = $1 AND event_id = $2`,
          [device.deviceId, e.event_id, verdict.reason],
        );
        results.set(index, { event_id: e.event_id, status: 'rejected', reason: verdict.reason });
      }
    }

    if (pending.length > 0) {
      await enqueue(
        tx,
        'ingest.process',
        { device_id: device.deviceId, event_ids: pending, offset_ms: offsetMs },
        { organizationId: device.organizationId },
      );
    }
    if (maxSeq >= 0) {
      // Gaps are health signals only; they never block ingestion.
      await tx.query(
        `UPDATE devices SET
           sequence_gaps = sequence_gaps + CASE WHEN last_sequence >= 0 AND $2 > last_sequence + 1 THEN 1 ELSE 0 END,
           last_sequence = GREATEST(last_sequence, $3), last_sync_at = $4,
           clock_offset_ms = $5::int, clock_skew_detected = (abs($5::int) > 120000)
         WHERE id = $1`,
        [device.deviceId, minSeq, maxSeq, receivedAt.toISOString(), Math.round(offsetMs)],
      );
    }
    void requestId;
    return {
      server_time: receivedAt.toISOString(),
      results: batch.events.map((_, i) => results.get(i)!),
    };
  });
}

type Verdict = { ok: true; deferred: boolean } | { ok: false; reason: string };

async function applyOrValidate(
  deps: Deps,
  tx: Queryable,
  device: DeviceActor,
  e: EventEnvelope,
  receivedAt: Date,
  offsetMs: number,
): Promise<Verdict> {
  const at = normalizeTime(e.occurred_at, receivedAt, offsetMs);
  if (isLifecycleEvent(e)) {
    let r;
    switch (e.event_type) {
      case 'session.started.v1':
        r = await startSession(deps, tx, device, {
          sessionId: e.session_id,
          projectId: e.payload.project_id,
          taskId: e.payload.task_id,
          at,
          clientAt: e.occurred_at,
          policyRevision: e.policy_version,
        });
        break;
      case 'session.paused.v1':
        r = await changeSessionState(tx, device, e.session_id, 'paused', at, e.payload.reason);
        break;
      case 'session.resumed.v1':
        r = await changeSessionState(tx, device, e.session_id, 'active', at, 'resume');
        break;
      case 'session.stopped.v1':
        r = await changeSessionState(tx, device, e.session_id, 'stopped', at, e.payload.reason);
        break;
    }
    if (r.ok) {
      await tx.query(`UPDATE ingest_events SET status = 'applied', processed_at = now() WHERE device_id = $1 AND event_id = $2`, [
        device.deviceId,
        e.event_id,
      ]);
      return { ok: true, deferred: false };
    }
    return r;
  }

  const s = await getSessionForDevice(tx, device, e.session_id);
  if (!s) return { ok: false, reason: 'unknown_session' };
  const start = new Date(s.started_at).getTime();
  // An open session may have data up to "now"; allow a minute of slack for clock jitter.
  const end = s.ended_at ? new Date(s.ended_at).getTime() : receivedAt.getTime() + 60_000;
  const shift = Math.abs(offsetMs) > 120_000 ? offsetMs : 0;

  // Windows are checked for overlap, not containment: a bucket is aligned to the
  // UTC minute and may begin up to 59 s before the session started.
  let from: number;
  let to: number;
  switch (e.event_type) {
    case 'activity_bucket.v1':
      from = new Date(e.payload.bucket_start).getTime() + Math.round(shift / 60_000) * 60_000;
      to = from + 60_000;
      break;
    case 'app_usage.v1':
      from = new Date(e.payload.started_at).getTime() + shift;
      to = from + e.payload.duration_seconds * 1000;
      break;
    case 'data_gap.v1':
      from = new Date(e.payload.gap_start).getTime() + shift;
      to = new Date(e.payload.gap_end).getTime() + shift;
      break;
  }
  if (to <= start - 5_000 || from >= end + 5_000) return { ok: false, reason: 'outside_session_window' };
  return { ok: true, deferred: true };
}
