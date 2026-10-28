import { z } from 'zod';

/**
 * Agent → API event contracts (system design §5.3).
 *
 * Payload schemas are strict: an unknown key is a validation error, so content
 * that the product must never collect (typed text, window titles, URLs) cannot
 * be smuggled into storage by a buggy or modified agent.
 */

export const uuid = z.uuid();
export const timestamp = z.iso.datetime({ offset: true });

export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_BATCH_BYTES = 1024 * 1024;

const minuteAligned = timestamp.refine((v) => {
  const d = new Date(v);
  return d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}, 'bucket_start must be aligned to a UTC minute');

export const sessionStartedPayload = z.strictObject({
  project_id: uuid.nullable().optional(),
  task_id: uuid.nullable().optional(),
});
export const sessionPausedPayload = z.strictObject({
  reason: z.enum(['user', 'idle_auto', 'work_hours']),
});
export const sessionResumedPayload = z.strictObject({});
export const SESSION_STOP_REASONS = ['user', 'logout', 'shutdown', 'revoked', 'policy', 'overlap'] as const;
export const sessionStoppedPayload = z.strictObject({
  reason: z.enum(SESSION_STOP_REASONS),
});

export const DATA_QUALITIES = ['ok', 'partial', 'permission_missing'] as const;
export const activityBucketPayload = z
  .strictObject({
    bucket_start: minuteAligned,
    active_seconds: z.number().int().min(0).max(60),
    idle_seconds: z.number().int().min(0).max(60),
    keyboard_count: z.number().int().min(0).max(100_000),
    mouse_count: z.number().int().min(0).max(100_000),
    data_quality: z.enum(DATA_QUALITIES),
  })
  .refine((p) => p.active_seconds + p.idle_seconds <= 60, 'active_seconds + idle_seconds must be ≤ 60');

export const appUsagePayload = z.strictObject({
  app_identifier: z.string().min(1).max(255),
  app_name: z.string().min(1).max(255),
  domain: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+$/i, 'domain only, no paths or queries')
    .nullable()
    .optional(),
  started_at: timestamp,
  duration_seconds: z.number().int().min(1).max(3600),
});

export const GAP_REASONS = ['suspended', 'offline_agent_stopped', 'permission_missing', 'clock_change'] as const;
export const dataGapPayload = z
  .strictObject({
    gap_start: timestamp,
    gap_end: timestamp,
    reason: z.enum(GAP_REASONS),
  })
  .refine((p) => new Date(p.gap_end) > new Date(p.gap_start), 'gap_end must be after gap_start');

const envelopeBase = {
  event_id: uuid,
  organization_id: uuid,
  device_id: uuid,
  session_id: uuid,
  policy_version: z.number().int().min(0),
  occurred_at: timestamp,
  sequence: z.number().int().min(0),
  monotonic_ms: z.number().int().min(0).optional(),
};

export const eventEnvelopeSchema = z.discriminatedUnion('event_type', [
  z.strictObject({ ...envelopeBase, event_type: z.literal('session.started.v1'), payload: sessionStartedPayload }),
  z.strictObject({ ...envelopeBase, event_type: z.literal('session.paused.v1'), payload: sessionPausedPayload }),
  z.strictObject({ ...envelopeBase, event_type: z.literal('session.resumed.v1'), payload: sessionResumedPayload }),
  z.strictObject({ ...envelopeBase, event_type: z.literal('session.stopped.v1'), payload: sessionStoppedPayload }),
  z.strictObject({ ...envelopeBase, event_type: z.literal('activity_bucket.v1'), payload: activityBucketPayload }),
  z.strictObject({ ...envelopeBase, event_type: z.literal('app_usage.v1'), payload: appUsagePayload }),
  z.strictObject({ ...envelopeBase, event_type: z.literal('data_gap.v1'), payload: dataGapPayload }),
]);
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventType = EventEnvelope['event_type'];
export type EventOf<T extends EventType> = Extract<EventEnvelope, { event_type: T }>;

export const LIFECYCLE_EVENT_TYPES = [
  'session.started.v1',
  'session.paused.v1',
  'session.resumed.v1',
  'session.stopped.v1',
] as const satisfies readonly EventType[];

export function isLifecycleEvent(
  e: EventEnvelope,
): e is EventOf<(typeof LIFECYCLE_EVENT_TYPES)[number]> {
  return (LIFECYCLE_EVENT_TYPES as readonly string[]).includes(e.event_type);
}

/**
 * The batch is validated loosely (each event is `unknown`) so that one bad event
 * is rejected individually instead of failing the whole batch.
 */
export const eventBatchSchema = z.strictObject({
  batch_id: uuid,
  sent_at: timestamp,
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

export const EVENT_RESULT_STATUSES = ['accepted', 'duplicate', 'rejected'] as const;
export interface EventResult {
  event_id: string | null;
  status: (typeof EVENT_RESULT_STATUSES)[number];
  reason?: string;
}
export interface EventBatchResponse {
  server_time: string;
  results: EventResult[];
}
