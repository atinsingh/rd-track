import { randomUUID } from 'node:crypto';
import type { ScreenshotDTO, UploadIntentResponse, ViewUrlResponse } from '@rd/contracts';
import type { Deps, DeviceActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { sha256Hex } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertCanView } from '../authz';
import { assertLicensedForTracking } from '../billing/service';
import { resolveFor } from '../policy/service';
import { getSessionForDevice } from '../sessions/service';

/** System design §6.5 (SCR-01..11). */

const INTENT_TTL_SEC = 300;
const VIEW_TTL_SEC = 60;

interface ScreenshotRow {
  id: string;
  organization_id: string;
  session_id: string;
  user_id: string;
  device_id: string;
  object_key: string;
  status: ScreenshotDTO['status'];
  bytes: number | null;
  sha256: string | null;
  captured_at: string | null;
  intent_expires_at: string;
}

export async function createUploadIntent(
  deps: Deps,
  q: Queryable,
  device: DeviceActor,
  input: { session_id: string; content_type: 'image/webp' | 'image/jpeg' },
): Promise<UploadIntentResponse> {
  const now = deps.now();
  await assertLicensedForTracking(q, device.organizationId, device.userId, now);
  const session = await getSessionForDevice(q, device, input.session_id);
  if (!session || session.state !== 'active') {
    throw new AppError(403, 'session_not_active', 'Screenshots are only captured during an active, unpaused session');
  }
  const { settings } = await resolveFor(deps, q, device.organizationId, device.userId, {
    projectId: session.project_id,
    deviceId: device.deviceId,
  });
  if (!settings.screenshots.enabled) {
    throw new AppError(403, 'screenshots_disabled', 'No published policy enables screenshots for this session');
  }
  // Never more than one capture per half interval, whatever the agent asks for.
  const recent = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM screenshots WHERE session_id = $1 AND created_at > $2`,
    [session.id, new Date(now.getTime() - (settings.screenshots.interval_minutes * 60_000) / 2).toISOString()],
  );
  if ((recent?.n ?? 0) > 0) throw new AppError(429, 'too_frequent', 'Screenshot interval not reached');

  const id = randomUUID();
  const ext = input.content_type === 'image/webp' ? 'webp' : 'jpg';
  const objectKey = `screenshots/${device.organizationId}/${randomUUID()}.${ext}`;
  const expires = new Date(now.getTime() + INTENT_TTL_SEC * 1000).toISOString();
  const retention = new Date(now.getTime() + settings.retention.screenshot_days * 86_400_000).toISOString();
  const policyRev = await one<{ policy_revision: number }>(q, 'SELECT policy_revision FROM organizations WHERE id = $1', [
    device.organizationId,
  ]);
  await q.query(
    `INSERT INTO screenshots (id, organization_id, session_id, user_id, device_id, object_key, content_type, status,
       policy_revision, intent_expires_at, retention_after, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)`,
    [id, device.organizationId, session.id, device.userId, device.deviceId, objectKey, input.content_type, policyRev!.policy_revision, expires, retention, now.toISOString()],
  );
  const put = await deps.store.presignPut(objectKey, input.content_type, INTENT_TTL_SEC);
  return { screenshot_id: id, upload_url: put.url, upload_headers: put.headers, expires_at: expires };
}

/** Was the session active (not paused, not stopped) at `at`? */
async function sessionActiveAt(q: Queryable, sessionId: string, at: string): Promise<boolean> {
  const last = await one<{ state: string }>(
    q,
    `SELECT state FROM session_transitions WHERE session_id = $1 AND at <= $2 ORDER BY at DESC, id DESC LIMIT 1`,
    [sessionId, at],
  );
  return last?.state === 'active';
}

export async function completeUpload(
  deps: Deps,
  q: Queryable,
  device: DeviceActor,
  input: { screenshot_id: string; captured_at: string; sha256: string; bytes: number; width: number; height: number },
): Promise<{ status: 'verifying' | 'discarded' }> {
  const row = await one<ScreenshotRow>(q, 'SELECT * FROM screenshots WHERE id = $1 AND device_id = $2 FOR UPDATE', [
    input.screenshot_id,
    device.deviceId,
  ]);
  if (!row) throw errors.notFound('Screenshot');
  if (row.status === 'deleted') return { status: 'discarded' };
  if (row.status !== 'pending') return { status: 'verifying' }; // idempotent retry
  const now = deps.now();
  const capturedAt = new Date(input.captured_at);
  const intentIssued = new Date(row.intent_expires_at).getTime() - INTENT_TTL_SEC * 1000;
  const plausible = capturedAt.getTime() >= intentIssued - 5_000 && capturedAt.getTime() <= now.getTime() + 5_000;

  // SCR-02: a capture after stop/pause, or claiming an implausible time, is deleted, not stored.
  if (!plausible || !(await sessionActiveAt(q, row.session_id, capturedAt.toISOString()))) {
    await deps.store.delete(row.object_key);
    await q.query(
      `UPDATE screenshots SET status = 'deleted', deleted_at = now(), deletion_reason = 'captured_outside_active_session' WHERE id = $1`,
      [row.id],
    );
    return { status: 'discarded' };
  }
  await q.query(
    `UPDATE screenshots SET status = 'verifying', captured_at = $2, sha256 = $3, bytes = $4, width = $5, height = $6 WHERE id = $1`,
    [row.id, capturedAt.toISOString(), input.sha256, input.bytes, input.width, input.height],
  );
  await enqueue(q, 'screenshot.verify', { screenshot_id: row.id }, { organizationId: row.organization_id });
  return { status: 'verifying' };
}

/** Worker: the stored object must exist and match the declared size and hash. */
export async function verifyScreenshot(deps: Deps, q: Queryable, screenshotId: string): Promise<'stored' | 'failed' | 'skipped'> {
  const row = await one<ScreenshotRow>(q, `SELECT * FROM screenshots WHERE id = $1 AND status = 'verifying'`, [screenshotId]);
  if (!row) return 'skipped';
  const body = await deps.store.get(row.object_key);
  const ok = body !== null && body.length === row.bytes && sha256Hex(body) === row.sha256;
  if (!ok) {
    if (body) await deps.store.delete(row.object_key);
    await q.query(`UPDATE screenshots SET status = 'failed', deletion_reason = 'verification_failed' WHERE id = $1`, [row.id]);
    return 'failed';
  }
  await q.query(`UPDATE screenshots SET status = 'stored' WHERE id = $1`, [row.id]);
  return 'stored';
}

export async function listScreenshots(q: Queryable, orgId: string, userId: string, r: { from: string; to: string }): Promise<ScreenshotDTO[]> {
  return many<ScreenshotDTO>(
    q,
    `SELECT s.id, s.session_id, s.user_id, s.captured_at, s.status, s.width, s.height, s.retention_after,
            (SELECT d.status FROM deletion_requests d WHERE d.target_id = s.id ORDER BY d.created_at DESC LIMIT 1) AS deletion_request_status,
            (SELECT a.app_name FROM app_usage a WHERE a.session_id = s.session_id AND a.started_at <= s.captured_at
               AND a.started_at + make_interval(secs => a.duration_seconds) > s.captured_at
             ORDER BY a.started_at DESC LIMIT 1) AS app_name
     FROM screenshots s
     WHERE s.organization_id = $1 AND s.user_id = $2 AND s.status IN ('stored', 'verifying')
       AND s.captured_at >= $3 AND s.captured_at < $4
     ORDER BY s.captured_at`,
    [orgId, userId, r.from, r.to],
  );
}

export async function viewUrl(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<ViewUrlResponse> {
  const row = await one<ScreenshotRow & { project_id: string | null }>(
    q,
    `SELECT s.*, w.project_id FROM screenshots s JOIN work_sessions w ON w.id = s.session_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [id, actor.organizationId],
  );
  if (!row || row.status !== 'stored') throw errors.notFound('Screenshot');
  await assertCanView(deps, q, actor, row.user_id, 'screenshots', { projectId: row.project_id, requestId });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'screenshot.view',
    targetType: 'screenshot',
    targetId: row.id,
    targetUserId: row.user_id,
    requestId,
    metadata: { captured_at: row.captured_at },
  });
  return {
    url: await deps.store.presignGet(row.object_key, VIEW_TTL_SEC),
    expires_at: new Date(deps.now().getTime() + VIEW_TTL_SEC * 1000).toISOString(),
  };
}

export async function underLegalHold(q: Queryable, userId: string, at: string | null): Promise<boolean> {
  if (!at) return false;
  const r = await one(
    q,
    `SELECT 1 FROM legal_holds WHERE user_id = $1 AND released_at IS NULL AND from_at <= $2 AND to_at >= $2 LIMIT 1`,
    [userId, at],
  );
  return r !== null;
}

/** Deletes the object first, then marks the row; the row stays so audit entries still resolve (SCR-10). */
export async function deleteScreenshot(deps: Deps, q: Queryable, id: string, reason: string): Promise<boolean> {
  const row = await one<ScreenshotRow>(q, `SELECT * FROM screenshots WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
  if (!row) return false;
  await deps.store.delete(row.object_key);
  await q.query(`UPDATE screenshots SET status = 'deleted', deleted_at = now(), deletion_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(q, {
    organizationId: row.organization_id,
    actor: { kind: 'system' },
    action: 'screenshot.deleted',
    targetType: 'screenshot',
    targetId: id,
    targetUserId: row.user_id,
    metadata: { reason },
  });
  return true;
}
