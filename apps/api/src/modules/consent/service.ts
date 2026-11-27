import { createHash } from 'node:crypto';
import {
  CONSENT_OUTDATED,
  CONSENT_REQUIRED,
  languageOf,
  renderAgreement,
  resolvePolicy,
  type AdminConsentResponse,
  type ConsentDecisionRequest,
  type ConsentRecordDTO,
  type ConsentStatus,
  type ConsentVersionDTO,
  type DeviceConsentResponse,
  type PersonConsentResponse,
} from '@rd/contracts';
import type { Deps, DeviceActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { localesOf } from '../../i18n';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { currentPlan } from '../billing/service';
import { loadScopes, planScope, resolveFor } from '../policy/service';

/**
 * Monitoring agreement (packages/contracts/src/consent.ts). One version per organization;
 * a person's status is their newest answer to the current version, from any of their computers.
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const consentRequired = () =>
  new AppError(403, CONSENT_REQUIRED, 'The monitoring agreement must be accepted on this computer before anything is tracked');

/** The version in force and the admin's own text for it (null = generated). */
async function current(q: Queryable, orgId: string): Promise<{ version: number; custom_text: string | null }> {
  const r = await one<{ version: number; custom_text: string | null }>(
    q,
    'SELECT version, custom_text FROM consent_agreements WHERE organization_id = $1 ORDER BY version DESC LIMIT 1',
    [orgId],
  );
  return r ?? { version: 1, custom_text: null };
}

/** The exact text this person is shown: the admin's, or generated from everything their policies collect. */
async function agreementText(deps: Deps, q: Queryable, orgId: string, userId: string, deviceId: string | null, custom: string | null) {
  if (custom !== null) return custom;
  const org = await one<{ name: string }>(q, 'SELECT name FROM organizations WHERE id = $1', [orgId]);
  // As on the person's "What's collected" page: the base policy plus each project they work on.
  const projects = await many<{ id: string }>(
    q,
    `SELECT DISTINCT p.id FROM projects p
     WHERE p.organization_id = $1 AND p.status = 'active' AND (
       p.id IN (SELECT project_id FROM project_memberships WHERE user_id = $2 AND valid_to IS NULL)
       OR p.id IN (SELECT project_id FROM work_sessions WHERE user_id = $2 AND started_at > $3::timestamptz))
     ORDER BY p.id`,
    [orgId, userId, new Date(deps.now().getTime() - 30 * 86_400_000).toISOString()],
  );
  const settings = [(await resolveFor(deps, q, orgId, userId, { deviceId })).settings];
  for (const p of projects) settings.push((await resolveFor(deps, q, orgId, userId, { projectId: p.id, deviceId })).settings);
  const locale = (await localesOf(q, [userId])).get(userId) ?? 'en-US';
  return renderAgreement({ organizationName: org!.name, settings, language: languageOf(locale) });
}

/** Each person's answer to `version`: their newest record for it, else pending. */
export async function consentStatuses(q: Queryable, orgId: string, userIds: readonly string[]): Promise<Map<string, ConsentStatus>> {
  const { version } = await current(q, orgId);
  const rows = await many<{ user_id: string; decision: 'accepted' | 'declined' }>(
    q,
    `SELECT DISTINCT ON (user_id) user_id, decision FROM consent_records
     WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND version = $3
     ORDER BY user_id, seq DESC`,
    [orgId, userIds, version],
  );
  const out = new Map<string, ConsentStatus>(userIds.map((id) => [id, 'pending']));
  for (const r of rows) out.set(r.user_id, r.decision);
  return out;
}

/** Tracking endpoints call this: a person without an acceptance of the current version is refused. */
export async function assertConsented(q: Queryable, device: DeviceActor): Promise<void> {
  const s = await consentStatuses(q, device.organizationId, [device.userId]);
  if (s.get(device.userId) !== 'accepted') throw consentRequired();
}

export async function deviceConsent(deps: Deps, q: Queryable, device: DeviceActor): Promise<DeviceConsentResponse> {
  const { version, custom_text } = await current(q, device.organizationId);
  const text = await agreementText(deps, q, device.organizationId, device.userId, device.deviceId, custom_text);
  const last = await one<{ decision: 'accepted' | 'declined'; decided_at: string }>(
    q,
    `SELECT decision, decided_at FROM consent_records WHERE organization_id = $1 AND user_id = $2 AND version = $3
     ORDER BY seq DESC LIMIT 1`,
    [device.organizationId, device.userId, version],
  );
  return { version, text, text_sha256: sha256(text), status: last?.decision ?? 'pending', decided_at: last?.decided_at ?? null };
}

/**
 * Stores an accept or decline of exactly what the server would show now. A stale version
 * or text is refused (`409 consent_outdated`) so the app re-asks with the current one.
 * `ip` is the address the server saw (`req.ip`), never one the client reports.
 */
export async function recordDecision(
  deps: Deps,
  q: Queryable,
  device: DeviceActor,
  input: ConsentDecisionRequest,
  ip: string,
  requestId?: string,
): Promise<DeviceConsentResponse> {
  const orgId = device.organizationId;
  // Serialized with version bumps (publishPolicy, setAgreementText) so an answer can't land on a version that just ended.
  await q.query('SELECT 1 FROM organizations WHERE id = $1 FOR SHARE', [orgId]);
  const shown = await deviceConsent(deps, q, device);
  if (input.version !== shown.version || input.text_sha256 !== shown.text_sha256) {
    throw errors.conflict(CONSENT_OUTDATED, 'The agreement changed since it was shown; show the current one', {
      version: shown.version,
    });
  }
  const at = deps.now().toISOString();
  await q.query(
    `INSERT INTO consent_records (organization_id, user_id, device_id, version, decision, text_sha256, text, ip, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [orgId, device.userId, device.deviceId, shown.version, input.decision, shown.text_sha256, shown.text, ip, at],
  );
  if (input.decision === 'declined') await stopOpenSessions(q, orgId, [device.userId], at);
  await audit(q, {
    organizationId: orgId,
    actor: device,
    action: `consent.${input.decision}`,
    targetType: 'consent',
    targetId: String(shown.version),
    targetUserId: device.userId,
    requestId,
    metadata: { version: shown.version, text_sha256: shown.text_sha256 },
  });
  return { ...shown, status: input.decision, decided_at: at };
}

/** Open sessions end now: nothing more is tracked until the person answers (again). */
async function stopOpenSessions(q: Queryable, orgId: string, userIds: readonly string[], at: string) {
  const open = await many<{ id: string }>(
    q,
    `UPDATE work_sessions SET state = 'stopped', ended_at = greatest($3::timestamptz, started_at), stop_reason = 'consent_required', updated_at = now()
     WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND state IN ('active', 'paused') AND ended_at IS NULL
     RETURNING id`,
    [orgId, userIds, at],
  );
  for (const s of open) {
    await q.query(
      `INSERT INTO session_transitions (session_id, organization_id, state, at, reason)
       SELECT id, organization_id, 'stopped', ended_at, 'consent_required' FROM work_sessions WHERE id = $1`,
      [s.id],
    );
  }
}

/**
 * A new agreement version everyone must accept. Called with the organization row locked
 * (publishPolicy locks it). An expansion keeps the admin's own text, if any.
 * Open sessions are left to the app: it stops at its next refused call, and its queued
 * stop (and the minutes before it, collected under the policy the person had accepted)
 * arrive once they answer; a decline ends them here (recordDecision).
 */
export async function bumpAgreement(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  reason: 'policy_expansion' | 'text_edited' | 'text_reset',
  actorId: string,
  customText?: string | null,
): Promise<number> {
  const prev = await current(q, orgId);
  const text = customText === undefined ? prev.custom_text : customText;
  const version = prev.version + 1;
  await q.query(
    `INSERT INTO consent_agreements (organization_id, version, custom_text, reason, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, version, text, reason, actorId, deps.now().toISOString()],
  );
  return version;
}

export async function personConsent(q: Queryable, orgId: string, userId: string): Promise<PersonConsentResponse> {
  const { version } = await current(q, orgId);
  const records = await many<ConsentRecordDTO>(
    q,
    `SELECT r.id, r.version, r.decision, r.text_sha256, r.text, r.ip, r.device_id, d.name AS device_name, r.decided_at
     FROM consent_records r JOIN devices d ON d.id = r.device_id
     WHERE r.organization_id = $1 AND r.user_id = $2 ORDER BY r.seq DESC LIMIT 200`,
    [orgId, userId],
  );
  return { required_version: version, status: records.find((r) => r.version === version)?.decision ?? 'pending', records };
}

export async function adminConsent(deps: Deps, q: Queryable, actor: UserActor): Promise<AdminConsentResponse> {
  const orgId = actor.organizationId;
  const { version, custom_text } = await current(q, orgId);
  const org = await one<{ name: string }>(q, 'SELECT name FROM organizations WHERE id = $1', [orgId]);
  // The organization's own policy only (a nil user is in no team), with the plan's limits.
  const scopes = await loadScopes(q, orgId, '00000000-0000-0000-0000-000000000000');
  const settings = resolvePolicy([...scopes, planScope(await currentPlan(q, orgId, deps.now()))]).settings;
  const locale = (await localesOf(q, [actor.userId])).get(actor.userId) ?? 'en-US';
  const history = await many<ConsentVersionDTO>(
    q,
    `SELECT a.version, a.reason, u.display_name AS created_by, a.created_at FROM consent_agreements a
     LEFT JOIN users u ON u.id = a.created_by WHERE a.organization_id = $1 ORDER BY a.version DESC LIMIT 50`,
    [orgId],
  );
  history.push({ version: 1, reason: 'initial', created_by: null, created_at: null });
  return {
    version,
    custom_text,
    generated_text: renderAgreement({ organizationName: org!.name, settings: [settings], language: languageOf(locale) }),
    history,
  };
}

/** Admin → Policies: the admin's own text (or back to the generated one). Always a new version. */
export async function setAgreementText(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  customText: string | null,
  requestId?: string,
): Promise<AdminConsentResponse> {
  await q.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [actor.organizationId]);
  const version = await bumpAgreement(deps, q, actor.organizationId, customText === null ? 'text_reset' : 'text_edited', actor.userId, customText);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'consent.text_updated',
    targetType: 'consent',
    targetId: String(version),
    requestId,
    metadata: { version, custom: customText !== null, text_sha256: customText === null ? null : sha256(customText) },
  });
  return adminConsent(deps, q, actor);
}
