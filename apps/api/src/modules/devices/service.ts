import { licenseState, type DeviceDTO, type EnrollResponse, type EnrollmentCodeResponse, type HeartbeatResponse } from '@rd/contracts';
import type { z } from 'zod';
import type { enrollRequest, heartbeatRequest } from '@rd/contracts';
import type { Deps, DeviceActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enrollmentCode, normalizeEnrollmentCode, randomToken, sha256Hex } from '../../lib/crypto';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertLicensedForTracking, currentSubscription } from '../billing/service';
import { publish } from '../engine/events';
import { assertInOrg } from '../org/service';
import { orgRevision } from '../policy/service';
import { localesOf } from '../../i18n';

const CODE_TTL_MIN = 30;

export async function createEnrollmentCode(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  userId: string,
  requestId?: string,
): Promise<EnrollmentCodeResponse> {
  await assertInOrg(q, actor.organizationId, 'users', userId, 'User');
  const u = await one<{ status: string; tracking_enabled: boolean }>(q, 'SELECT status, tracking_enabled FROM users WHERE id = $1', [userId]);
  if (u!.status !== 'active') throw errors.validation('User is deactivated');
  if (!u!.tracking_enabled) {
    // Viewer-only users are free seats; tracking (and its seat check) must be turned on first.
    throw errors.validation(
      userId === actor.userId
        ? 'Tracking is off for your account, so there is nothing to connect. An org admin can turn it on.'
        : 'Turn on tracking for this user before enrolling a device (it uses a licence seat).',
    );
  }
  const code = enrollmentCode();
  const expires = new Date(deps.now().getTime() + CODE_TTL_MIN * 60_000).toISOString();
  await q.query(
    `INSERT INTO enrollment_codes (organization_id, user_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [actor.organizationId, userId, sha256Hex(normalizeEnrollmentCode(code)), actor.userId, expires],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'device.enrollment_code_created',
    targetType: 'user',
    targetId: userId,
    targetUserId: userId,
    requestId,
  });
  return { code, expires_at: expires, user_id: userId };
}

export function dashboardUrl(deps: Deps): string {
  return `${deps.config.webUrl}/me`;
}

export async function enroll(
  deps: Deps,
  q: Queryable,
  input: z.infer<typeof enrollRequest>,
  requestId?: string,
): Promise<EnrollResponse> {
  const codeRow = await one<{ id: string; organization_id: string; user_id: string }>(
    q,
    `UPDATE enrollment_codes SET used_at = $2
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
     RETURNING id, organization_id, user_id`,
    [sha256Hex(normalizeEnrollmentCode(input.enrollment_code)), deps.now().toISOString()],
  );
  if (!codeRow) throw errors.unauthenticated('Enrollment code is invalid, expired or already used');
  await assertLicensedForTracking(q, codeRow.organization_id, codeRow.user_id, deps.now());

  const credential = randomToken(32);
  const dev = await one<{ id: string }>(
    q,
    `INSERT INTO devices (organization_id, user_id, name, os, os_version, agent_version, credential_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [codeRow.organization_id, codeRow.user_id, input.device_name, input.os, input.os_version, input.agent_version, sha256Hex(credential)],
  );
  await audit(q, {
    organizationId: codeRow.organization_id,
    actor: { kind: 'device', deviceId: dev!.id, userId: codeRow.user_id, organizationId: codeRow.organization_id },
    action: 'device.enrolled',
    targetType: 'device',
    targetId: dev!.id,
    targetUserId: codeRow.user_id,
    requestId,
    metadata: { os: input.os, agent_version: input.agent_version },
  });
  const key = deps.config.policySigningKey;
  return {
    device_id: dev!.id,
    user_id: codeRow.user_id,
    organization_id: codeRow.organization_id,
    device_credential: credential,
    policy_signing_key: { key_id: key.keyId, public_key_b64: key.publicKeyB64 },
    dashboard_url: dashboardUrl(deps),
  };
}

/** OS permissions that limit what can be measured. Accessibility is not used by the agent. */
const MEASURED_PERMISSIONS = [
  ['input_monitoring', 'Input Monitoring', 'computer activity'],
  ['screen_recording', 'Screen Recording', 'the screenshots your organization’s policy asks for'],
] as const;

export async function heartbeat(
  deps: Deps,
  q: Queryable,
  device: DeviceActor,
  input: z.infer<typeof heartbeatRequest>,
): Promise<HeartbeatResponse> {
  const now = deps.now();
  const offset = now.getTime() - new Date(input.client_time).getTime();
  const before = await one<{ name: string; permissions: Record<string, string> | null }>(q, 'SELECT name, permissions FROM devices WHERE id = $1', [device.deviceId]);
  await q.query(
    `UPDATE devices SET last_seen_at = $2, agent_version = $3, permissions = $4,
       applied_policy_revision = COALESCE($5, applied_policy_revision),
       clock_offset_ms = $6::int, clock_skew_detected = (abs($6::int) > 120000),
       browser_extensions = $7
     WHERE id = $1`,
    [device.deviceId, now.toISOString(), input.agent_version, input.permissions, input.applied_policy_revision, Math.round(offset), [...new Set(input.browser_extensions ?? [])].sort()],
  );
  // A permission the agent needs was just turned off (or never granted): tell the person, once a day.
  for (const [key, label, what] of MEASURED_PERMISSIONS) {
    if (input.permissions[key] === 'denied' && before?.permissions?.[key] !== 'denied') {
      await publish(q, {
        organizationId: device.organizationId,
        type: 'device.permission_missing',
        subjectUserId: device.userId,
        data: { device_id: device.deviceId, device_name: before?.name ?? 'Your computer', permission: key, permission_label: label, what },
        dedupeKey: `permission:${device.deviceId}:${key}:${now.toISOString().slice(0, 10)}`,
      });
    }
  }
  if (input.applied_policy_revision !== null) {
    await q.query(
      `INSERT INTO policy_receipts (device_id, organization_id, revision) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [device.deviceId, device.organizationId, input.applied_policy_revision],
    );
  }
  // A lapsed licence or a user without a seat is reported as an error so the agent stops visibly.
  await assertLicensedForTracking(q, device.organizationId, device.userId, now);
  const sub = await currentSubscription(q, device.organizationId, now);
  const license = licenseState(sub.status);
  return {
    server_time: now.toISOString(),
    policy_revision: await orgRevision(q, device.organizationId),
    credential_status: 'active',
    license: license === 'grace' && sub.grace_ends_at ? { status: license, grace_ends_at: sub.grace_ends_at } : { status: license },
    dashboard_url: dashboardUrl(deps),
    // The person's language (G27): theirs, else the organization's; null lets the computer decide.
    locale: (await localesOf(q, [device.userId], { withoutDefault: true })).get(device.userId) ?? null,
  };
}

/** Every device in the organization, or only one person's (their own "My computers"). */
export async function listDevices(q: Queryable, orgId: string, userId: string | null = null): Promise<DeviceDTO[]> {
  return many<DeviceDTO>(
    q,
    `SELECT d.id, d.user_id, u.display_name AS user_name, d.name, d.os, d.os_version, d.agent_version, d.credential_status,
            d.enrolled_at, d.revoked_at, d.last_seen_at, d.last_sync_at, d.applied_policy_revision,
            o.policy_revision AS current_policy_revision, d.permissions, d.clock_skew_detected, d.sequence_gaps,
            d.browser_extensions
     FROM devices d JOIN users u ON u.id = d.user_id JOIN organizations o ON o.id = d.organization_id
     WHERE d.organization_id = $1 AND ($2::uuid IS NULL OR d.user_id = $2)
     ORDER BY d.credential_status, u.display_name, d.name`,
    [orgId, userId],
  );
}

/** IAM-05 / DEV-04: revocation is immediate; open sessions on the device stop. */
export async function revokeDevice(deps: Deps, q: Queryable, actor: UserActor, deviceId: string, requestId?: string) {
  const now = deps.now().toISOString();
  const d = await one<{ user_id: string; name: string }>(
    q,
    `UPDATE devices SET credential_status = 'revoked', revoked_at = $3
     WHERE id = $1 AND organization_id = $2 AND credential_status = 'active' RETURNING user_id, name`,
    [deviceId, actor.organizationId, now],
  );
  if (!d) {
    await assertInOrg(q, actor.organizationId, 'devices', deviceId, 'Device');
    return; // already revoked
  }
  const open = await many<{ id: string }>(
    q,
    `UPDATE work_sessions SET state = 'stopped', ended_at = $2, stop_reason = 'revoked', updated_at = now()
     WHERE device_id = $1 AND state IN ('active', 'paused') RETURNING id`,
    [deviceId, now],
  );
  for (const s of open) {
    await q.query(
      `INSERT INTO session_transitions (session_id, organization_id, state, at, reason) VALUES ($1, $2, 'stopped', $3, 'revoked')`,
      [s.id, actor.organizationId, now],
    );
  }
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'device.revoked',
    targetType: 'device',
    targetId: deviceId,
    targetUserId: d.user_id,
    requestId,
    metadata: { stopped_sessions: open.length },
  });
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'device.revoked',
    subjectUserId: d.user_id,
    actorUserId: actor.userId,
    data: { device_id: deviceId, device_name: d.name },
  });
}
