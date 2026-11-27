import { createHash } from 'node:crypto';
import {
  CONSENT_OUTDATED,
  CONSENT_REQUIRED,
  languageOf,
  renderAgreement,
  resolvePolicy,
  type AdminConsentResponse,
  type AppLanguage,
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
import { ADMIN_ROLES } from '../../http';
import { audit } from '../audit/service';
import { publish } from '../engine/events';
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

/**
 * The exact text shown on one computer: generated from everything collected there (the base
 * policy and each project the person belongs to or tracked on in the last 30 days, each with
 * that computer's own policy), or the admin's text followed by the same lists. `deviceId` null
 * is the person without a computer in particular (nothing enrolled yet).
 */
async function agreementText(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userId: string,
  deviceId: string | null,
  custom: string | null,
) {
  const org = await one<{ name: string }>(q, 'SELECT name FROM organizations WHERE id = $1', [orgId]);
  // The same projects the person's "What's collected" page covers: whatever a session there collects is in the text.
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
  const render = (language: AppLanguage) => renderAgreement({ organizationName: org!.name, settings, language, customText: custom });
  // An acceptance of the same agreement in another language still counts: changing language is not collecting more.
  return { text: render(languageOf(locale)), sameIn: (['en', 'fr'] as const).map((l) => sha256(render(l))) };
}

interface Answer {
  status: ConsentStatus;
  decided_at: string | null;
  asked_again_at: string | null;
}

/**
 * A person's answer to `version` on a computer whose text hashes to one of `hashes`. Only an
 * acceptance of that exact text counts: joining a team or project that collects more, a
 * device policy or a plan change all change the text and need a new acceptance. A decline
 * (from any of their computers) stands until they accept or someone asks again.
 */
async function answerFor(q: Queryable, orgId: string, userId: string, version: number, hashes: readonly string[]): Promise<Answer> {
  const rows = await many<{ seq: string; decision: 'accepted' | 'declined'; text_sha256: string; decided_at: string }>(
    q,
    `SELECT seq, decision, text_sha256, decided_at FROM consent_records
     WHERE organization_id = $1 AND user_id = $2 AND version = $3 ORDER BY seq DESC LIMIT 100`,
    [orgId, userId, version],
  );
  const asked = await one<{ at: string }>(
    q,
    'SELECT max(requested_at) AS at FROM consent_requests WHERE organization_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  const asked_again_at = asked?.at ?? null;
  const decline = rows.find((r) => r.decision === 'declined');
  const after = (r: { seq: string }) => !decline || BigInt(r.seq) > BigInt(decline.seq);
  const ok = rows.find((r) => r.decision === 'accepted' && hashes.includes(r.text_sha256) && after(r));
  if (ok) return { status: 'accepted', decided_at: ok.decided_at, asked_again_at };
  // Still declined unless they accepted somewhere since, or were asked again (an ask in the same millisecond counts as after).
  const reopened = rows.some((r) => r.decision === 'accepted' && after(r)) || (asked_again_at && Date.parse(asked_again_at) >= Date.parse(decline!.decided_at));
  if (decline && !reopened) return { status: 'declined', decided_at: decline.decided_at, asked_again_at };
  return { status: 'pending', decided_at: null, asked_again_at };
}

async function answerNow(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, userId: string, deviceId: string | null) {
  const { version, custom_text } = await current(q, orgId);
  const { text, sameIn } = await agreementText(deps, q, orgId, userId, deviceId, custom_text);
  return { version, text, text_sha256: sha256(text), ...(await answerFor(q, orgId, userId, version, sameIn)) };
}

const RANK: Record<ConsentStatus, number> = { accepted: 0, pending: 1, declined: 2 };

/**
 * A person's answer across their computers: declined if they declined, pending while any
 * active computer still needs an acceptance of its text, else accepted.
 */
async function personAnswer(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, userId: string) {
  const devices = await many<{ id: string }>(
    q,
    `SELECT id FROM devices WHERE organization_id = $1 AND user_id = $2 AND credential_status = 'active' ORDER BY id`,
    [orgId, userId],
  );
  let worst = await answerNow(deps, q, orgId, userId, devices[0]?.id ?? null);
  for (const d of devices.slice(1)) {
    const a = await answerNow(deps, q, orgId, userId, d.id);
    if (RANK[a.status] > RANK[worst.status]) worst = a;
  }
  return worst;
}

/**
 * Each person's answer, for the team report.
 * ponytail: resolves policies per person and computer on every call (a few queries each); cache if reports get slow.
 */
export async function consentStatuses(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, ConsentStatus>> {
  const out = new Map<string, ConsentStatus>();
  for (const id of userIds) out.set(id, (await personAnswer(deps, q, orgId, id)).status);
  return out;
}

/** Tracking endpoints call this: without an acceptance of the exact text this computer would show now, refused. */
export async function assertConsented(deps: Pick<Deps, 'now'>, q: Queryable, device: DeviceActor): Promise<void> {
  if ((await answerNow(deps, q, device.organizationId, device.userId, device.deviceId)).status !== 'accepted') throw consentRequired();
}

export async function deviceConsent(deps: Pick<Deps, 'now'>, q: Queryable, device: DeviceActor): Promise<DeviceConsentResponse> {
  const a = await answerNow(deps, q, device.organizationId, device.userId, device.deviceId);
  return { version: a.version, text: a.text, text_sha256: a.text_sha256, status: a.status, decided_at: a.decided_at };
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
  if (input.decision === 'declined') {
    await stopOpenSessions(q, orgId, [device.userId], at);
    // Their managers and the admins hear about it (in-app and email) so someone follows up.
    const who = await one<{ display_name: string }>(q, 'SELECT display_name FROM users WHERE id = $1', [device.userId]);
    await publish(q, {
      organizationId: orgId,
      type: 'consent.declined',
      subjectUserId: device.userId,
      data: { user_name: who?.display_name ?? '', version: shown.version },
    });
  }
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

/**
 * A person's consent. The stored answers (text, IP, computer) go only to the person
 * themselves and to admins (`includeRecords`); managers get the status to follow up.
 */
export async function personConsent(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userId: string,
  includeRecords: boolean,
): Promise<PersonConsentResponse> {
  const now = await personAnswer(deps, q, orgId, userId);
  const records = includeRecords
    ? await many<ConsentRecordDTO>(
        q,
        `SELECT r.id, r.version, r.decision, r.text_sha256, r.text, r.ip, r.device_id, d.name AS device_name, r.decided_at
         FROM consent_records r JOIN devices d ON d.id = r.device_id
         WHERE r.organization_id = $1 AND r.user_id = $2 ORDER BY r.seq DESC LIMIT 200`,
        [orgId, userId],
      )
    : [];
  return { required_version: now.version, status: now.status, asked_again_at: now.asked_again_at, records };
}

/**
 * "Ask again" from a manager of one of their teams or an admin: recorded (append-only and
 * audited), the person's answer goes back to pending, and the app shows the agreement on
 * its next check. What happens on continued refusal is for the organization (HR) to decide.
 */
export async function askAgain(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, userId: string, requestId?: string): Promise<PersonConsentResponse> {
  const orgId = actor.organizationId;
  const { version } = await current(q, orgId);
  await q.query(
    'INSERT INTO consent_requests (organization_id, user_id, requested_by, version, requested_at) VALUES ($1, $2, $3, $4, $5)',
    [orgId, userId, actor.userId, version, deps.now().toISOString()],
  );
  await audit(q, {
    organizationId: orgId,
    actor,
    action: 'consent.asked_again',
    targetType: 'consent',
    targetId: String(version),
    targetUserId: userId,
    requestId,
    metadata: { version },
  });
  return personConsent(deps, q, orgId, userId, ADMIN_ROLES.includes(actor.orgRole));
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
