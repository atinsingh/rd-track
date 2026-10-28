import { z } from 'zod';
import { timestamp, uuid } from './events';
import type { LicenseState } from './plans';
import type { PolicySettings } from './policy';

/** Agent ↔ API request/response contracts (system design §5.2). */

const permissionState = z.enum(['granted', 'denied', 'not_required', 'unknown']);

export const enrollRequest = z.strictObject({
  enrollment_code: z.string().min(6).max(32),
  device_name: z.string().min(1).max(200),
  os: z.enum(['windows', 'macos', 'linux']),
  os_version: z.string().min(1).max(100),
  agent_version: z.string().min(1).max(50),
});
export interface EnrollResponse {
  device_id: string;
  user_id: string;
  organization_id: string;
  device_credential: string;
  policy_signing_key: { key_id: string; public_key_b64: string };
  /** The employee's own dashboard, opened by the tray's "My dashboard". */
  dashboard_url: string;
}

export const heartbeatRequest = z.strictObject({
  agent_version: z.string().min(1).max(50),
  client_time: timestamp,
  permissions: z.strictObject({
    input_monitoring: permissionState,
    screen_recording: permissionState,
    accessibility: permissionState,
  }),
  outbox_depth: z.number().int().min(0),
  applied_policy_revision: z.number().int().min(0).nullable(),
});
export interface HeartbeatResponse {
  server_time: string;
  policy_revision: number;
  credential_status: 'active' | 'revoked';
  license: { status: LicenseState; grace_ends_at?: string };
  dashboard_url: string;
}

/** `GET /v1/device/projects`: what the device's user may book time to (tray pickers). */
export interface DeviceProjectsResponse {
  projects: { id: string; name: string; tasks: { id: string; name: string }[] }[];
}

export const devicePolicyQuery = z.object({ project_id: uuid.optional() });

/** The JSON document whose exact bytes are base64-encoded and signed. */
export interface SignedPolicyPayload {
  organization_id: string;
  user_id: string;
  device_id: string;
  project_id: string | null;
  revision: number;
  issued_at: string;
  settings: PolicySettings;
}
export interface DevicePolicyResponse {
  payload_b64: string;
  signature_b64: string;
  key_id: string;
}

export const sessionCreateRequest = z.strictObject({
  session_id: uuid,
  project_id: uuid.nullable().optional(),
  task_id: uuid.nullable().optional(),
  client_started_at: timestamp.optional(),
});
export const sessionStopRequest = z.strictObject({
  reason: z.enum(['user', 'logout', 'shutdown', 'revoked', 'policy', 'overlap']).default('user'),
});

// ───────────── Stage 4 F4 / F3: limit warnings and reminders ─────────────

/** The agent leaves out its own running session and adds it locally, so a warning never waits for an upload. */
export const deviceWorkLimitsQuery = z.object({ exclude_session_id: uuid.optional() });

/**
 * `GET /v1/device/work-limits`: daily and weekly limits with time worked so far, for the
 * tray's banners at 80% and 100%. `enabled: false` on plans without work limits. A limit
 * never stops a session; it only informs the person.
 */
export type DeviceWorkLimitsResponse =
  | { enabled: false }
  | {
      enabled: true;
      as_of: string;
      timezone: string;
      daily_minutes: number | null;
      weekly_minutes: number | null;
      today: { date: string; worked_seconds: number };
      week: { period_start: string; worked_seconds: number };
    };

/**
 * `GET /v1/device/schedule-today`: the person's working hours today, so start / stop /
 * "still tracking?" reminders stay inside them.
 * - `scheduled: false`: no schedule (or the plan has none); the agent uses the hours the
 *   person set in the tray.
 * - `scheduled: true` with `shift: null`: not a working day.
 * - `day_off`: a holiday, a cancelled shift or approved full-day leave; no reminders.
 */
export interface DeviceScheduleTodayResponse {
  date: string;
  timezone: string;
  scheduled: boolean;
  shift: { start_at: string; end_at: string } | null;
  day_off: 'holiday' | 'cancelled' | 'leave' | null;
}
