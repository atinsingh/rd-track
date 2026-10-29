import type {
  MyTimeOffResponse,
  TimeOffAccrualDay,
  TimeOffAssignmentDTO,
  TimeOffBalanceDTO,
  TimeOffLedgerEntryDTO,
  TimeOffPolicyDTO,
  TimeOffRequestDTO,
  timeOffAdjustmentCreate,
  timeOffAssignmentCreate,
  timeOffPolicyCreate,
  timeOffPolicyUpdate,
  timeOffRequestCreate,
} from '@rd/contracts';
import type { z } from 'zod';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, withTx, type Queryable } from '../../db/pool';
import { SYSTEM_SCOPE, withScope } from '../../db/tenant-scope';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { isTeamManagerOf } from '../authz';
import { publish, reviewersOf } from '../engine/events';
import { leaveHoursOn } from './attendance';
import { entitlementsOf, getSettings, loadCalendars, notify, todayFor } from './service';
import { daysBetween, eachDate } from './tz';

/**
 * Time off: policies with accrual, per-person assignments, requests reviewed by the
 * person's team managers (or org admins), and a ledger whose sum is the balance.
 */

const MAX_REQUEST_DAYS = 366;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────── policies & assignments (admin) ─────────────

const POLICY_SELECT = `
  SELECT p.id, p.name, p.kind, p.accrual, p.accrual_hours, p.accrual_day, p.max_balance_hours, p.carryover_hours, p.allow_negative,
         p.archived_at IS NOT NULL AS archived,
         (SELECT count(*)::int FROM time_off_assignments a WHERE a.policy_id = p.id) AS assigned_count
  FROM time_off_policies p`;

export async function listPolicies(q: Queryable, orgId: string): Promise<TimeOffPolicyDTO[]> {
  return many<TimeOffPolicyDTO>(q, `${POLICY_SELECT} WHERE p.organization_id = $1 ORDER BY p.archived_at NULLS FIRST, lower(p.name)`, [orgId]);
}

async function getPolicy(q: Queryable, orgId: string, id: string): Promise<TimeOffPolicyDTO> {
  const p = await one<TimeOffPolicyDTO>(q, `${POLICY_SELECT} WHERE p.id = $1 AND p.organization_id = $2`, [id, orgId]);
  if (!p) throw errors.notFound('Time-off policy');
  return p;
}

export async function createPolicy(q: Queryable, actor: UserActor, input: z.infer<typeof timeOffPolicyCreate>, requestId?: string): Promise<TimeOffPolicyDTO> {
  const dup = await one(q, 'SELECT 1 FROM time_off_policies WHERE organization_id = $1 AND name = $2', [actor.organizationId, input.name]);
  if (dup) throw errors.conflict('policy_exists', 'A time-off policy with this name already exists');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO time_off_policies (organization_id, name, kind, accrual, accrual_hours, max_balance_hours, carryover_hours, allow_negative, accrual_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.organizationId, input.name, input.kind, input.accrual, input.accrual_hours, input.max_balance_hours ?? null, input.carryover_hours ?? null, input.allow_negative, input.accrual_day],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'time_off_policy.create', targetType: 'time_off_policy', targetId: r!.id, requestId });
  return getPolicy(q, actor.organizationId, r!.id);
}

export async function updatePolicy(q: Queryable, actor: UserActor, id: string, patch: z.infer<typeof timeOffPolicyUpdate>, requestId?: string): Promise<TimeOffPolicyDTO> {
  const cur = await getPolicy(q, actor.organizationId, id);
  if (patch.name && patch.name !== cur.name) {
    const dup = await one(q, 'SELECT 1 FROM time_off_policies WHERE organization_id = $1 AND name = $2', [actor.organizationId, patch.name]);
    if (dup) throw errors.conflict('policy_exists', 'A time-off policy with this name already exists');
  }
  await q.query(
    `UPDATE time_off_policies SET name = $2, accrual = $3, accrual_hours = $4, max_balance_hours = $5, carryover_hours = $6, allow_negative = $7,
       archived_at = CASE WHEN $8::boolean IS NULL THEN archived_at WHEN $8 THEN COALESCE(archived_at, now()) ELSE NULL END, accrual_day = $9
     WHERE id = $1`,
    [
      id,
      patch.name ?? cur.name,
      patch.accrual ?? cur.accrual,
      patch.accrual_hours ?? cur.accrual_hours,
      patch.max_balance_hours === undefined ? cur.max_balance_hours : patch.max_balance_hours,
      patch.carryover_hours === undefined ? cur.carryover_hours : patch.carryover_hours,
      patch.allow_negative ?? cur.allow_negative,
      patch.archived ?? null,
      patch.accrual_day ?? cur.accrual_day,
    ],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'time_off_policy.update', targetType: 'time_off_policy', targetId: id, requestId });
  return getPolicy(q, actor.organizationId, id);
}

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.policy_id, p.name AS policy_name, a.user_id, u.display_name AS user_name, a.start_date,
         COALESCE((SELECT sum(l.hours) FROM time_off_ledger l WHERE l.user_id = a.user_id AND l.policy_id = a.policy_id), 0) AS balance_hours
  FROM time_off_assignments a JOIN time_off_policies p ON p.id = a.policy_id JOIN users u ON u.id = a.user_id`;

export async function listAssignments(q: Queryable, orgId: string, f: { policyId?: string; userId?: string } = {}): Promise<TimeOffAssignmentDTO[]> {
  return many<TimeOffAssignmentDTO>(
    q,
    `${ASSIGNMENT_SELECT} WHERE a.organization_id = $1 AND ($2::uuid IS NULL OR a.policy_id = $2) AND ($3::uuid IS NULL OR a.user_id = $3)
     ORDER BY lower(p.name), lower(u.display_name)`,
    [orgId, f.policyId ?? null, f.userId ?? null],
  );
}

async function ledgerInsert(
  q: Queryable,
  e: { orgId: string; userId: string; policyId: string; kind: TimeOffLedgerEntryDTO['kind']; hours: number; date: string; period?: string; requestId?: string; note?: string; by?: string | null },
): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO time_off_ledger (organization_id, user_id, policy_id, kind, hours, effective_date, period, request_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
    [e.orgId, e.userId, e.policyId, e.kind, round2(e.hours), e.date, e.period ?? null, e.requestId ?? null, e.note ?? null, e.by ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function assignPolicy(q: Queryable, actor: UserActor, input: z.infer<typeof timeOffAssignmentCreate>, requestId?: string): Promise<TimeOffAssignmentDTO> {
  const policy = await getPolicy(q, actor.organizationId, input.policy_id);
  if (policy.archived) throw errors.validation('This policy is archived');
  const u = await one(q, 'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2', [input.user_id, actor.organizationId]);
  if (!u) throw errors.notFound('User');
  const exists = await one(q, 'SELECT 1 FROM time_off_assignments WHERE policy_id = $1 AND user_id = $2', [input.policy_id, input.user_id]);
  if (exists) throw errors.conflict('already_assigned', 'This person is already on this policy');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO time_off_assignments (organization_id, policy_id, user_id, start_date, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [actor.organizationId, input.policy_id, input.user_id, input.start_date, actor.userId],
  );
  if (input.opening_balance_hours) {
    await ledgerInsert(q, {
      orgId: actor.organizationId,
      userId: input.user_id,
      policyId: input.policy_id,
      kind: 'adjustment',
      hours: input.opening_balance_hours,
      date: input.start_date,
      note: 'Opening balance',
      by: actor.userId,
    });
  }
  await audit(q, { organizationId: actor.organizationId, actor, action: 'time_off_assignment.create', targetType: 'time_off_policy', targetId: input.policy_id, targetUserId: input.user_id, requestId });
  return (await one<TimeOffAssignmentDTO>(q, `${ASSIGNMENT_SELECT} WHERE a.id = $1`, [r!.id]))!;
}

/** Removes the assignment; the ledger is kept (history and balance stay visible if reassigned). */
export async function removeAssignment(q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await one<{ user_id: string; policy_id: string }>(
    q,
    'DELETE FROM time_off_assignments WHERE id = $1 AND organization_id = $2 RETURNING user_id, policy_id',
    [id, actor.organizationId],
  );
  if (!r) throw errors.notFound('Assignment');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'time_off_assignment.delete', targetType: 'time_off_policy', targetId: r.policy_id, targetUserId: r.user_id, requestId });
}

export async function adjustBalance(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, input: z.infer<typeof timeOffAdjustmentCreate>, requestId?: string) {
  await getPolicy(q, actor.organizationId, input.policy_id);
  const a = await one(q, 'SELECT 1 FROM time_off_assignments WHERE policy_id = $1 AND user_id = $2 AND organization_id = $3', [
    input.policy_id,
    input.user_id,
    actor.organizationId,
  ]);
  if (!a) throw errors.validation('This person is not on this policy');
  await ledgerInsert(q, {
    orgId: actor.organizationId,
    userId: input.user_id,
    policyId: input.policy_id,
    kind: 'adjustment',
    hours: input.hours,
    date: await todayFor(deps, q, actor.organizationId, input.user_id),
    note: input.note,
    by: actor.userId,
  });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'time_off_balance.adjust',
    targetType: 'time_off_policy',
    targetId: input.policy_id,
    targetUserId: input.user_id,
    requestId,
    metadata: { hours: input.hours },
  });
  await notify(q, actor.organizationId, input.user_id, 'time_off_adjustment', 'Your time-off balance changed', `${input.hours > 0 ? '+' : ''}${input.hours} h: ${input.note}`);
  return (await listAssignments(q, actor.organizationId, { policyId: input.policy_id, userId: input.user_id }))[0]!;
}

// ───────────── balances & requests ─────────────

async function balanceOf(q: Queryable, userId: string, policyId: string): Promise<{ balance: number; pending: number }> {
  const r = await one<{ balance: number; pending: number }>(
    q,
    `SELECT COALESCE((SELECT sum(hours) FROM time_off_ledger WHERE user_id = $1 AND policy_id = $2), 0) AS balance,
            COALESCE((SELECT sum(hours) FROM time_off_requests WHERE user_id = $1 AND policy_id = $2 AND status = 'pending'), 0) AS pending`,
    [userId, policyId],
  );
  return { balance: Number(r!.balance), pending: Number(r!.pending) };
}

const REQUEST_SELECT = `
  SELECT r.id, r.user_id, u.display_name AS user_name, r.policy_id, p.name AS policy_name, p.kind AS policy_kind,
         r.start_date, r.end_date, r.partial_hours, r.hours, r.reason, r.status, r.reviewed_by, rv.display_name AS reviewer_name,
         r.reviewed_at, r.review_note, r.created_at
  FROM time_off_requests r
  JOIN users u ON u.id = r.user_id
  JOIN time_off_policies p ON p.id = r.policy_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by`;

async function getRequest(q: Queryable, id: string): Promise<TimeOffRequestDTO> {
  return (await one<TimeOffRequestDTO>(q, `${REQUEST_SELECT} WHERE r.id = $1`, [id]))!;
}

export async function myTimeOff(q: Queryable, actor: UserActor): Promise<MyTimeOffResponse> {
  const balances = await many<TimeOffBalanceDTO>(
    q,
    `SELECT p.id AS policy_id, p.name AS policy_name, p.kind, p.accrual, p.accrual_hours, p.allow_negative, a.start_date AS assigned_from,
            COALESCE((SELECT sum(l.hours) FROM time_off_ledger l WHERE l.user_id = a.user_id AND l.policy_id = p.id), 0) AS balance_hours,
            COALESCE((SELECT sum(r.hours) FROM time_off_requests r WHERE r.user_id = a.user_id AND r.policy_id = p.id AND r.status = 'pending'), 0) AS pending_hours
     FROM time_off_assignments a JOIN time_off_policies p ON p.id = a.policy_id
     WHERE a.organization_id = $1 AND a.user_id = $2 AND p.archived_at IS NULL ORDER BY lower(p.name)`,
    [actor.organizationId, actor.userId],
  );
  const requests = await many<TimeOffRequestDTO>(q, `${REQUEST_SELECT} WHERE r.organization_id = $1 AND r.user_id = $2 ORDER BY r.start_date DESC, r.created_at DESC LIMIT 200`, [
    actor.organizationId,
    actor.userId,
  ]);
  const ledger = await many<TimeOffLedgerEntryDTO>(
    q,
    `SELECT id::text, policy_id, kind, hours, effective_date, note, request_id, created_at FROM time_off_ledger
     WHERE organization_id = $1 AND user_id = $2 ORDER BY effective_date DESC, id DESC LIMIT 200`,
    [actor.organizationId, actor.userId],
  );
  return { balances, requests, ledger };
}

/** Hours a request would cost: partial hours as given, else each day per the person's schedule. */
export async function estimateHours(
  q: Queryable,
  orgId: string,
  userId: string,
  input: { start_date: string; end_date: string; partial_hours?: number },
): Promise<number> {
  if (daysBetween(input.start_date, input.end_date) + 1 > MAX_REQUEST_DAYS) throw errors.validation(`A request may cover at most ${MAX_REQUEST_DAYS} days`);
  if (input.partial_hours !== undefined) return round2(input.partial_hours);
  const settings = await getSettings(q, orgId);
  const cal = (await loadCalendars(q, orgId, [userId], input.start_date, input.end_date)).get(userId)!;
  const s = { ...settings, default_day_hours: Number(settings.default_day_hours) };
  return round2(eachDate(input.start_date, input.end_date).reduce((n, d) => n + leaveHoursOn(cal, d, s), 0));
}

function insufficient(balance: number, pending: number, requested: number) {
  return errors.conflict('insufficient_balance', 'Not enough time-off balance for this request', {
    balance_hours: round2(balance),
    pending_hours: round2(pending),
    requested_hours: round2(requested),
  });
}

export async function createRequest(q: Queryable, actor: UserActor, input: z.infer<typeof timeOffRequestCreate>, requestId?: string): Promise<TimeOffRequestDTO> {
  const policy = await one<{ kind: string; allow_negative: boolean; archived: boolean; name: string }>(
    q,
    `SELECT p.kind, p.allow_negative, p.archived_at IS NOT NULL AS archived, p.name FROM time_off_policies p
     JOIN time_off_assignments a ON a.policy_id = p.id AND a.user_id = $2
     WHERE p.id = $1 AND p.organization_id = $3`,
    [input.policy_id, actor.userId, actor.organizationId],
  );
  if (!policy || policy.archived) throw errors.validation("You aren't on this time-off policy");
  const overlap = await one(
    q,
    `SELECT 1 FROM time_off_requests WHERE user_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3 AND end_date >= $2 LIMIT 1`,
    [actor.userId, input.start_date, input.end_date],
  );
  if (overlap) throw errors.conflict('overlapping_time_off', 'You already have time off requested for some of these dates');
  const hours = await estimateHours(q, actor.organizationId, actor.userId, input);
  if (hours <= 0) throw errors.validation('There are no scheduled working hours in these dates');
  if (policy.kind === 'paid' && !policy.allow_negative) {
    const { balance, pending } = await balanceOf(q, actor.userId, input.policy_id);
    if (balance - pending < hours) throw insufficient(balance, pending, hours);
  }
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO time_off_requests (organization_id, user_id, policy_id, start_date, end_date, partial_hours, hours, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [actor.organizationId, actor.userId, input.policy_id, input.start_date, input.end_date, input.partial_hours ?? null, hours, input.reason?.trim() || null],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'time_off_request.create', targetType: 'time_off_request', targetId: r!.id, targetUserId: actor.userId, requestId });
  // Tell the people who can approve it: the person's team managers, or the org admins when there are none.
  const span = input.start_date === input.end_date ? input.start_date : `${input.start_date} – ${input.end_date}`;
  for (const reviewer of await reviewersOf(q, actor.organizationId, actor.userId)) {
    await notify(q, actor.organizationId, reviewer, 'time_off_request', `Time off request from ${actor.displayName}`, `${span} · ${hours} h. Review it in Approvals.`);
  }
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'time_off.requested',
    subjectUserId: actor.userId,
    actorUserId: actor.userId,
    data: { request_id: r!.id, start_date: input.start_date, end_date: input.end_date },
  });
  return getRequest(q, r!.id);
}

/** Pending requests the actor may review: members of teams they manage (admins: everyone). Never their own. */
export async function pendingForReviewer(q: Queryable, actor: UserActor): Promise<TimeOffRequestDTO[]> {
  return many<TimeOffRequestDTO>(
    q,
    `${REQUEST_SELECT} WHERE r.organization_id = $1 AND r.status = 'pending' AND r.user_id <> $2 AND (
       $3::boolean OR EXISTS (
         SELECT 1 FROM team_memberships m JOIN team_memberships t ON t.team_id = m.team_id
         WHERE m.user_id = $2 AND m.role = 'manager' AND m.valid_to IS NULL AND t.user_id = r.user_id AND t.valid_to IS NULL))
     ORDER BY r.created_at`,
    [actor.organizationId, actor.userId, isAdmin(actor)],
  );
}

export async function reviewRequest(q: Queryable, actor: UserActor, id: string, approve: boolean, note: string | undefined, requestId?: string): Promise<TimeOffRequestDTO> {
  const r = await one<{ user_id: string; status: string; policy_id: string; hours: number; start_date: string; end_date: string }>(
    q,
    'SELECT user_id, status, policy_id, hours, start_date, end_date FROM time_off_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, actor.organizationId],
  );
  if (!r) throw errors.notFound('Time-off request');
  if (r.user_id === actor.userId) throw errors.forbidden('You cannot review your own time-off request');
  if (!isAdmin(actor) && !(await isTeamManagerOf(q, actor.userId, r.user_id))) throw errors.forbidden();
  if (r.status !== 'pending') throw errors.conflict('already_reviewed', 'This request has already been reviewed');
  if (approve) {
    const p = await one<{ kind: string; allow_negative: boolean }>(q, 'SELECT kind, allow_negative FROM time_off_policies WHERE id = $1', [r.policy_id]);
    if (p!.kind === 'paid' && !p!.allow_negative) {
      const { balance, pending } = await balanceOf(q, r.user_id, r.policy_id);
      if (balance < Number(r.hours)) throw insufficient(balance, pending, Number(r.hours));
    }
    await ledgerInsert(q, {
      orgId: actor.organizationId,
      userId: r.user_id,
      policyId: r.policy_id,
      kind: 'usage',
      hours: -Number(r.hours),
      date: r.start_date,
      requestId: id,
      by: actor.userId,
    });
  }
  await q.query(`UPDATE time_off_requests SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`, [
    id,
    approve ? 'approved' : 'denied',
    actor.userId,
    note?.trim() || null,
  ]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: approve ? 'time_off_request.approve' : 'time_off_request.deny',
    targetType: 'time_off_request',
    targetId: id,
    targetUserId: r.user_id,
    requestId,
  });
  const span = r.start_date === r.end_date ? r.start_date : `${r.start_date} – ${r.end_date}`;
  await notify(
    q,
    actor.organizationId,
    r.user_id,
    'time_off_review',
    approve ? 'Time off approved' : 'Time off not approved',
    `${span}${note?.trim() ? ` · “${note.trim()}”` : ''}`,
  );
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'time_off.decided',
    subjectUserId: r.user_id,
    actorUserId: actor.userId,
    data: { request_id: id, start_date: r.start_date, end_date: r.end_date, approved: approve },
  });
  return getRequest(q, id);
}

/** The employee withdraws a pending request, or approved leave that hasn't started (hours go back). */
export async function cancelRequest(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<TimeOffRequestDTO> {
  const r = await one<{ status: string; policy_id: string; hours: number; start_date: string }>(
    q,
    'SELECT status, policy_id, hours, start_date FROM time_off_requests WHERE id = $1 AND user_id = $2 AND organization_id = $3 FOR UPDATE',
    [id, actor.userId, actor.organizationId],
  );
  if (!r) throw errors.notFound('Time-off request');
  if (r.status !== 'pending' && r.status !== 'approved') throw errors.conflict('not_cancellable', 'This request is already closed');
  if (r.status === 'approved') {
    const today = await todayFor(deps, q, actor.organizationId, actor.userId);
    if (r.start_date <= today) throw errors.conflict('time_off_started', 'This time off has started; ask your manager or an admin to adjust it');
    await ledgerInsert(q, {
      orgId: actor.organizationId,
      userId: actor.userId,
      policyId: r.policy_id,
      kind: 'usage_reversal',
      hours: Number(r.hours),
      date: r.start_date,
      requestId: id,
      note: 'Cancelled by employee',
      by: actor.userId,
    });
  }
  await q.query(`UPDATE time_off_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [id]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'time_off_request.cancel',
    targetType: 'time_off_request',
    targetId: id,
    targetUserId: actor.userId,
    requestId,
    metadata: { was: r.status },
  });
  return getRequest(q, id);
}

// ───────────── accrual job ─────────────

interface AccrualRow {
  user_id: string;
  policy_id: string;
  start_date: string;
  accrual: 'per_month' | 'per_year';
  accrual_day: TimeOffAccrualDay;
  accrual_hours: number;
  max_balance_hours: number | null;
  carryover_hours: number | null;
}

function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The period whose accrual falls due by `today` (Stage 4 F9), or null if it isn't due yet:
 * on the 1st, on the last day, or on the day the assignment started (the last day of a
 * shorter month for the 29th–31st). Each period is credited once, so a due period stays
 * due for the rest of it and a late run still credits it.
 */
export function accrualDue(accrual: 'per_month' | 'per_year', day: TimeOffAccrualDay, startDate: string, today: string): string | null {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const [, sm, sd] = startDate.split('-').map(Number) as [number, number, number];
  const period = accrual === 'per_month' ? today.slice(0, 7) : today.slice(0, 4);
  if (day === 'first') return period;
  if (accrual === 'per_month') {
    const due = day === 'last' ? lastDayOf(y, m) : Math.min(sd, lastDayOf(y, m));
    return d >= due ? period : null;
  }
  const [dm, dd] = day === 'last' ? [12, 31] : [sm, Math.min(sd, lastDayOf(y, sm))];
  return m > dm || (m === dm && d >= dd) ? period : null;
}

/**
 * Adds this period's accrual for every assignment on an accruing policy, and at the start
 * of a calendar year expires hours above the policy's carryover. Safe to run any number of
 * times: the ledger allows one accrual and one expiry per person, policy and period.
 * Accrual is not prorated and missed periods are not back-filled (the worker runs it
 * every few hours, so a period is only missed if the worker is down for all of it).
 */
export async function runAccruals(deps: Pick<Deps, 'now' | 'pool'>, now = deps.now()): Promise<{ accrued: number; expired: number }> {
  const today = now.toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const orgs = await withScope(SYSTEM_SCOPE, () =>
    many<{ organization_id: string }>(
      deps.pool,
      `SELECT DISTINCT a.organization_id FROM time_off_assignments a JOIN time_off_policies p ON p.id = a.policy_id
       WHERE p.accrual <> 'none' AND p.archived_at IS NULL AND a.start_date <= $1`,
      [today],
    ),
  );
  let accrued = 0;
  let expired = 0;
  for (const { organization_id: orgId } of orgs) {
    await withScope(orgId, async () => {
      if (!(await entitlementsOf(deps, deps.pool, orgId)).time_off) return;
      await withTx(deps.pool, async (tx) => {
        const rows = await many<AccrualRow>(
          tx,
          `SELECT a.user_id, a.policy_id, a.start_date, p.accrual, p.accrual_day, p.accrual_hours, p.max_balance_hours, p.carryover_hours
           FROM time_off_assignments a JOIN time_off_policies p ON p.id = a.policy_id JOIN users u ON u.id = a.user_id
           WHERE a.organization_id = $1 AND p.accrual <> 'none' AND p.archived_at IS NULL AND a.start_date <= $2 AND u.status = 'active'`,
          [orgId, today],
        );
        for (const row of rows) {
          const base = { orgId, userId: row.user_id, policyId: row.policy_id, by: null };
          if (row.carryover_hours !== null && row.start_date < `${year}-01-01`) {
            const prior = await one<{ h: number }>(
              tx,
              `SELECT COALESCE(sum(hours), 0) AS h FROM time_off_ledger WHERE user_id = $1 AND policy_id = $2 AND effective_date < $3`,
              [row.user_id, row.policy_id, `${year}-01-01`],
            );
            const excess = Number(prior!.h) - Number(row.carryover_hours);
            if (excess > 0) {
              const done = await ledgerInsert(tx, { ...base, kind: 'carryover_expiry', hours: -excess, date: `${year}-01-01`, period: year, note: `Above the ${row.carryover_hours} h carryover` });
              if (done) expired++;
            }
          }
          const period = accrualDue(row.accrual, row.accrual_day, row.start_date, today);
          if (!period) continue;
          let amount = Number(row.accrual_hours);
          if (row.max_balance_hours !== null) {
            const { balance } = await balanceOf(tx, row.user_id, row.policy_id);
            amount = Math.min(amount, Math.max(0, Number(row.max_balance_hours) - balance));
          }
          if (amount <= 0) continue;
          const done = await ledgerInsert(tx, { ...base, kind: 'accrual', hours: amount, date: today, period });
          if (done) accrued++;
        }
      });
    });
  }
  return { accrued, expired };
}
