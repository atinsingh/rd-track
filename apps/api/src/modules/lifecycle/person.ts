import type { ErasureRequestDTO } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import type { EmailMessage } from '../../email/sender';
import { enqueue } from '../../jobs/queue';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { orgAdmins } from '../engine/events';
import { notify } from '../engine/notify';
import { deactivateUser } from '../org/service';
import { deleteScreenshot } from '../screenshots/service';
import { tableCsv } from './tables';
import { langOfUser } from '../../i18n';

/**
 * A person's own data (slice 5c, G18): "download my data", and erasure that an org admin
 * approves. Erasure deletes what Track measured about the person, except what a legal
 * hold covers, and replaces their name and email; time records the organization must
 * keep for pay and billing stay, attached to the placeholder.
 */

/** What a person's export holds: everything about them, including activity and screenshots. */
const PERSON_TABLES: { table: string; where: string; drop?: string[] }[] = [
  { table: 'work_sessions', where: 'user_id = $2' },
  { table: 'session_transitions', where: 'session_id IN (SELECT id FROM work_sessions WHERE user_id = $2)' },
  { table: 'activity_buckets', where: 'user_id = $2' },
  { table: 'app_usage', where: 'user_id = $2' },
  { table: 'data_gaps', where: 'user_id = $2' },
  { table: 'idle_decisions', where: 'user_id = $2' },
  { table: 'screenshots', where: 'user_id = $2', drop: ['object_key'] },
  { table: 'time_corrections', where: 'user_id = $2' },
  { table: 'timesheets', where: 'user_id = $2' },
  { table: 'time_off_requests', where: 'user_id = $2' },
  { table: 'time_off_ledger', where: 'user_id = $2' },
  { table: 'expenses', where: 'user_id = $2', drop: ['receipt_key'] },
  { table: 'payroll_adjustments', where: 'user_id = $2' },
  { table: 'shifts', where: 'user_id = $2' },
  { table: 'team_memberships', where: 'user_id = $2' },
  { table: 'project_memberships', where: 'user_id = $2' },
  { table: 'devices', where: 'user_id = $2', drop: ['credential_hash'] },
  { table: 'deletion_requests', where: 'requester_id = $2' },
  { table: 'notifications', where: 'user_id = $2' },
  // Who did what with your data, and what you did.
  { table: 'audit_logs', where: `(target_user_id = $2 OR (actor_type = 'user' AND actor_id = $2))` },
];

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export async function personFiles(deps: Deps, q: Queryable, orgId: string, userId: string): Promise<{ name: string; data: Buffer | string }[]> {
  const me = await one<Record<string, unknown>>(
    q,
    `SELECT u.id, u.email, u.display_name, u.org_role, u.status, u.tracking_enabled, u.timezone, u.created_at, o.name AS organization
     FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1 AND u.organization_id = $2`,
    [userId, orgId],
  );
  const files: { name: string; data: Buffer | string }[] = [];
  const counts: Record<string, number> = {};
  for (const t of PERSON_TABLES) {
    const { csv, rows } = await tableCsv(q, t.table, `organization_id = $1 AND ${t.where}`, [orgId, userId], t.drop);
    files.push({ name: `${t.table}.csv`, data: csv });
    counts[t.table] = rows;
  }
  const shots = await many<{ id: string; object_key: string; content_type: string; captured_at: string }>(
    q,
    `SELECT id, object_key, content_type, captured_at FROM screenshots WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL AND status = 'stored'`,
    [orgId, userId],
  );
  let images = 0;
  for (const s of shots) {
    const body = await deps.store.get(s.object_key);
    if (!body) continue;
    files.push({ name: `screenshots/${s.captured_at.replace(/[:.]/g, '-')}_${s.id.slice(0, 8)}.${EXT[s.content_type] ?? 'bin'}`, data: body });
    images++;
  }
  files.unshift(
    {
      name: 'README.txt',
      data: [
        `Your data in ${String(me!.organization)} — RoundDigital Track`,
        `Generated ${deps.now().toISOString()} (UTC) for ${String(me!.display_name)}.`,
        '',
        'Everything Track holds about you: work sessions and their pauses, per-minute activity counts',
        '(active and idle seconds, never what you typed), the app in front, gaps, idle decisions, screenshots',
        '(the images are in screenshots/), corrections, timesheets, time off, shifts, teams and projects,',
        'your computers, your notifications, and the audit log entries about you or by you — including every',
        'time someone else viewed your data. Times are UTC (ISO 8601).',
        '',
        'Rows per file:',
        ...Object.entries(counts).map(([t, n]) => `  ${t}.csv  ${n}`),
        `  screenshots/  ${images} images`,
      ].join('\n'),
    },
    { name: 'profile.json', data: JSON.stringify(me, null, 2) },
  );
  return files;
}

// ───────────── erasure ─────────────

const SELECT = `
  SELECT e.id, e.user_id, u.display_name AS user_name, e.reason, e.status, e.created_at, d.display_name AS decided_by_name,
         e.decided_at, e.decline_reason, e.completed_at, e.result
  FROM erasure_requests e JOIN users u ON u.id = e.user_id LEFT JOIN users d ON d.id = e.decided_by`;

export async function myErasureRequest(q: Queryable, actor: UserActor): Promise<ErasureRequestDTO | null> {
  return one<ErasureRequestDTO>(q, `${SELECT} WHERE e.organization_id = $1 AND e.user_id = $2 ORDER BY e.created_at DESC LIMIT 1`, [actor.organizationId, actor.userId]);
}

export async function listErasureRequests(q: Queryable, orgId: string): Promise<ErasureRequestDTO[]> {
  return many<ErasureRequestDTO>(q, `${SELECT} WHERE e.organization_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [orgId]);
}

async function getRequest(q: Queryable, orgId: string, id: string): Promise<ErasureRequestDTO> {
  const r = await one<ErasureRequestDTO>(q, `${SELECT} WHERE e.organization_id = $1 AND e.id = $2`, [orgId, id]);
  if (!r) throw errors.notFound('Erasure request');
  return r;
}

export async function requestErasure(q: Queryable, actor: UserActor, reason: string | undefined, requestId?: string): Promise<ErasureRequestDTO> {
  const open = await one(q, `SELECT 1 FROM erasure_requests WHERE user_id = $1 AND status IN ('pending', 'approved')`, [actor.userId]);
  if (open) throw errors.conflict('erasure_pending', 'You already asked; an org admin will decide');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO erasure_requests (organization_id, user_id, reason) VALUES ($1, $2, $3) RETURNING id`,
    [actor.organizationId, actor.userId, reason?.trim() || null],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'erasure.requested', targetType: 'erasure_request', targetId: r!.id, targetUserId: actor.userId, requestId });
  const me = await one<{ display_name: string }>(q, 'SELECT display_name FROM users WHERE id = $1', [actor.userId]);
  await notify(q, actor.organizationId, (await orgAdmins(q, actor.organizationId)).filter((id) => id !== actor.userId), {
    kind: 'erasure_request',
    category: 'approvals',
    title: (l) => l.t('erasure.asked.title', { name: me!.display_name }),
    body: (l) => l.t('erasure.asked.body'),
    link: '/admin/requests',
  });
  return getRequest(q, actor.organizationId, r!.id);
}

/**
 * An org admin decides; nobody decides their own. Approving deactivates the person now
 * (sign-ins and computers stop) and queues the erasure.
 */
export async function decideErasure(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  approve: boolean,
  declineReason: string | undefined,
  requestId?: string,
): Promise<ErasureRequestDTO> {
  const r = await getRequest(q, actor.organizationId, id);
  if (r.user_id === actor.userId) throw errors.forbidden('Another org admin has to decide about your own data');
  if (r.status !== 'pending') throw errors.conflict('already_decided', 'This request has already been decided');
  if (!approve && !declineReason) throw errors.validation('Say why, so they know');
  await q.query(`UPDATE erasure_requests SET status = $2, decided_by = $3, decided_at = $4, decline_reason = $5 WHERE id = $1`, [
    id,
    approve ? 'approved' : 'declined',
    actor.userId,
    deps.now().toISOString(),
    approve ? null : declineReason,
  ]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: approve ? 'erasure.approved' : 'erasure.declined',
    targetType: 'erasure_request',
    targetId: id,
    targetUserId: r.user_id,
    requestId,
  });
  if (approve) {
    const u = await one<{ status: string }>(q, 'SELECT status FROM users WHERE id = $1', [r.user_id]);
    if (u!.status === 'active') await deactivateUser(deps, q, actor, r.user_id, requestId);
    await enqueue(q, 'person.erase', { erasure_request_id: id }, { organizationId: actor.organizationId });
  } else {
    await notify(q, actor.organizationId, [r.user_id], {
      kind: 'erasure_declined',
      category: 'privacy',
      title: (l) => l.t('erasure.declined.title'),
      body: (l) => l.t('erasure.declined.body', { reason: declineReason ?? '' }),
      link: '/me/privacy',
    });
  }
  return getRequest(q, actor.organizationId, id);
}

/** Runs the erasure (job). Returns the confirmation to email once committed. */
export async function erasePerson(deps: Deps, q: Queryable, requestId: string): Promise<EmailMessage | null> {
  const r = await one<{ organization_id: string; user_id: string }>(
    q,
    `SELECT organization_id, user_id FROM erasure_requests WHERE id = $1 AND status = 'approved' FOR UPDATE`,
    [requestId],
  );
  if (!r) return null;
  const { organization_id: orgId, user_id: userId } = r;
  const who = await one<{ email: string; org: string }>(q, 'SELECT u.email, o.name AS org FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1', [userId]);
  // Their language, read before the account is emptied.
  const l = await langOfUser(q, userId);
  const held = (col: string) => `EXISTS (SELECT 1 FROM legal_holds h WHERE h.user_id = $1 AND h.released_at IS NULL AND ${col} BETWEEN h.from_at AND h.to_at)`;
  const deleted: Record<string, number> = {};
  const kept: Record<string, number> = {};
  for (const [table, col] of [
    ['activity_buckets', 'bucket_start'],
    ['app_usage', 'started_at'],
    ['data_gaps', 'gap_start'],
    ['idle_decisions', 'idle_started_at'],
  ] as const) {
    deleted[table] = (await q.query(`DELETE FROM ${table} WHERE user_id = $1 AND NOT ${held(col)}`, [userId])).rowCount ?? 0;
    const k = (await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]))!.n;
    if (k) kept[table] = k;
  }
  const shots = await many<{ id: string }>(q, `SELECT id FROM screenshots s WHERE user_id = $1 AND deleted_at IS NULL AND NOT ${held('s.captured_at')}`, [userId]);
  deleted.screenshots = 0;
  for (const s of shots) if (await deleteScreenshot(deps, q, s.id, 'erasure')) deleted.screenshots++;
  const heldShots = (await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM screenshots WHERE user_id = $1 AND deleted_at IS NULL', [userId]))!.n;
  if (heldShots) kept.screenshots = heldShots;
  // Claims never approved go, receipts and all; approved ones stay as payroll and invoice records, like time records.
  const claims = await many<{ receipt_key: string | null }>(q, `DELETE FROM expenses WHERE user_id = $1 AND status <> 'approved' RETURNING receipt_key`, [userId]);
  for (const c of claims) if (c.receipt_key) await deps.store.delete(c.receipt_key);
  deleted.expenses = claims.length;
  for (const table of ['notifications', 'notification_preferences', 'auth_tokens', 'mfa_recovery_codes', 'enrollment_codes', 'user_sessions']) {
    deleted[table] = (await q.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId])).rowCount ?? 0;
  }
  const exports = await many<{ id: string; object_key: string | null }>(q, `SELECT id, object_key FROM data_exports WHERE subject_user_id = $1`, [userId]);
  for (const e of exports) if (e.object_key) await deps.store.delete(e.object_key);
  deleted.data_exports = (await q.query('DELETE FROM data_exports WHERE subject_user_id = $1', [userId])).rowCount ?? 0;
  await q.query(`UPDATE devices SET name = 'Erased device', permissions = '{}'::jsonb WHERE user_id = $1`, [userId]);
  await q.query(
    `UPDATE users SET display_name = 'Erased person', email = $2, password_hash = NULL, mfa_secret_enc = NULL, mfa_enabled = false,
       tracking_enabled = false, status = 'deactivated', erased_at = $3 WHERE id = $1`,
    [userId, `erased-${userId}@erased.invalid`, deps.now().toISOString()],
  );
  const result = { deleted, kept_for_legal_hold: kept };
  await q.query(`UPDATE erasure_requests SET status = 'completed', completed_at = $2, result = $3 WHERE id = $1`, [requestId, deps.now().toISOString(), result]);
  await audit(q, { organizationId: orgId, actor: { kind: 'system' }, action: 'user.erased', targetType: 'user', targetId: userId, targetUserId: userId, metadata: result });
  const keptLine = Object.keys(kept).length
    ? l.t('erasure.done.kept', { list: Object.entries(kept).map(([t, n]) => `${t.replace(/_/g, ' ')} ${n}`).join(', ') })
    : l.t('erasure.done.noHold');
  const deletedList = Object.entries(deleted).filter(([, n]) => n > 0).map(([t, n]) => `${t.replace(/_/g, ' ')} ${n}`).join(', ');
  return {
    to: who!.email,
    subject: l.t('erasure.done.subject', { org: who!.org }),
    text: [
      l.t('erasure.done.intro', { org: who!.org }),
      '',
      l.t('erasure.done.deleted', { list: deletedList || l.t('erasure.done.nothing') }),
      keptLine,
      l.t('erasure.done.replaced'),
      '',
      l.t('erasure.done.last'),
    ].join('\n'),
  };
}
