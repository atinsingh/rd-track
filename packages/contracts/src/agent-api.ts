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
