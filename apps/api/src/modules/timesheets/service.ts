import {
  MAX_WEEKS_PER_QUERY,
  addCalendarDays,
  computeOvertime,
  hasEntitlement,
  isoWeekStart,
  weekDates,
  weeksBetween,
  type DeviceWorkLimitsResponse,
  type EffectiveWorkLimits,
  type MemberOvertimeRow,
  type MyWorkLimitsResponse,
  type TeamOvertimeReport,
  type TimesheetDTO,
  type TimesheetDay,
  type TimesheetEventDTO,
  type TimesheetProjectRow,
  type TimesheetStatus,
  type TimesheetSummary,
  type TimesheetTotals,
  type WorkLimits,
  type WorkLimitsResponse,
  type WorkLimitsUpdate,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertCanView, assertSameOrgUser, isTeamManagerOf } from '../authz';
import { currentSubscription } from '../billing/service';
import { publish } from '../engine/events';
import { notify as notifyPeople } from '../engine/notify';

/**
 * Weekly timesheets (submit → approve/reject, approval locks the week), work limits and
 * overtime. See migration 004 for the week/time-zone rules.
 */

// ───────────────────────── plan gate ─────────────────────────

export async function timesheetsEnabled(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string): Promise<boolean> {
  const sub = await currentSubscription(q, orgId, deps.now());
  return sub.status === 'trialing' || hasEntitlement(sub.plan, 'timesheets');
}

export async function requireTimesheets(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string): Promise<void> {
  if (!(await timesheetsEnabled(deps, q, orgId))) {
    throw errors.paymentRequired('Timesheets, work limits and overtime are part of the Standard and Pro plans.');
  }
}

// ───────────────────────── time zones ─────────────────────────

function safeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The calendar date of instant `at` in `tz`. */
export function dateInZone(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface Person {
  id: string;
  display_name: string;
  timezone: string;
}

async function person(q: Queryable, orgId: string, userId: string): Promise<Person> {
  const p = await one<Person>(q, 'SELECT id, display_name, timezone FROM users WHERE id = $1 AND organization_id = $2', [userId, orgId]);
  if (!p) throw errors.notFound('User');
  return { ...p, timezone: safeZone(p.timezone) };
}

// ───────────────────────── limits ─────────────────────────

interface LimitRow {
  user_id: string | null;
  daily_minutes: number | null;
  weekly_minutes: number | null;
  effective_from: string;
}

async function limitRows(q: Queryable, orgId: string, userIds: string[]): Promise<LimitRow[]> {
  return many<LimitRow>(
    q,
    `SELECT user_id, daily_minutes, weekly_minutes, effective_from::text AS effective_from FROM work_limits
     WHERE organization_id = $1 AND (user_id IS NULL OR user_id = ANY($2::uuid[]))
     ORDER BY effective_from DESC`,
    [orgId, userIds],
  );
}

function latest(rows: LimitRow[], userId: string | null, onDate: string): LimitRow | undefined {
  // rows are sorted by effective_from DESC
  return rows.find((r) => r.user_id === userId && r.effective_from <= onDate);
}

/** Limits in force on `onDate`: per-user fields override the organization default. */
export function resolveLimits(rows: LimitRow[], userId: string, onDate: string): EffectiveWorkLimits {
  const org = latest(rows, null, onDate);
  const own = latest(rows, userId, onDate);
  const pick = (k: 'daily_minutes' | 'weekly_minutes'): [number | null, EffectiveWorkLimits['daily_source']] => {
    if (own && own[k] !== null) return [own[k], 'user'];
    if (org && org[k] !== null) return [org[k], 'organization'];
    return [null, 'none'];
  };
  const [daily, dailySource] = pick('daily_minutes');
  const [weekly, weeklySource] = pick('weekly_minutes');
  return { daily_minutes: daily, weekly_minutes: weekly, daily_source: dailySource, weekly_source: weeklySource };
}

const plainLimits = (l: EffectiveWorkLimits): WorkLimits => ({ daily_minutes: l.daily_minutes, weekly_minutes: l.weekly_minutes });

// ───────────────────────── hours ─────────────────────────

interface SessionTime {
  date: string;
  project_id: string | null;
  project_name: string;
  kind: 'tracked' | 'manual' | 'corrected';
  seconds: number;
}

/**
 * Time per session for sessions that start in [fromDate, toDate) local to `tz`, attributed
 * to the local day the session starts on. Agent sessions count their measured minutes;
 * approved manual entries count their full span; agent sessions changed by an approved
 * correction count the corrected span minus any pauses inside it.
 */
async function sessionTimes(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userId: string,
  tz: string,
  fromDate: string,
  toDate: string,
  excludeSessionId: string | null = null,
): Promise<SessionTime[]> {
  const rows = await many<{
    id: string;
    source: 'agent' | 'manual';
    corrected: boolean;
    project_id: string | null;
    project_name: string | null;
    started_at: string;
    ended_at: string | null;
    date: string;
    bucket_seconds: number;
  }>(
    q,
    `SELECT s.id, s.source, s.corrected, s.project_id, p.name AS project_name, s.started_at, s.ended_at,
            to_char(s.started_at AT TIME ZONE $3, 'YYYY-MM-DD') AS date, COALESCE(b.secs, 0)::int AS bucket_seconds
     FROM work_sessions s
     LEFT JOIN projects p ON p.id = s.project_id
     LEFT JOIN LATERAL (SELECT sum(active_seconds + idle_seconds) AS secs FROM activity_buckets WHERE session_id = s.id) b ON true
     WHERE s.organization_id = $1 AND s.user_id = $2
       AND s.started_at >= ($4::date::timestamp AT TIME ZONE $3) AND s.started_at < ($5::date::timestamp AT TIME ZONE $3)
       AND ($6::uuid IS NULL OR s.id <> $6)`,
    [orgId, userId, tz, fromDate, toDate, excludeSessionId],
  );
  const corrected = rows.filter((r) => r.source === 'agent' && r.corrected && r.ended_at);
  const paused = await pausedWithin(deps, q, corrected);
  return rows.map((r) => {
    const span = r.ended_at ? (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000 : 0;
    let kind: SessionTime['kind'] = 'tracked';
    let seconds = r.bucket_seconds;
    if (r.source === 'manual') {
      kind = 'manual';
      seconds = span;
    } else if (r.corrected && r.ended_at) {
      kind = 'corrected';
      seconds = Math.max(0, span - (paused.get(r.id) ?? 0));
    }
    return { date: r.date, project_id: r.project_id, project_name: r.project_name ?? 'No project', kind, seconds: Math.round(seconds) };
  });
}

async function pausedWithin(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  sessions: { id: string; started_at: string; ended_at: string | null }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sessions.length === 0) return out;
  const rows = await many<{ session_id: string; state: string; at: string }>(
    q,
    `SELECT session_id, state, at FROM session_transitions WHERE session_id = ANY($1::uuid[]) ORDER BY session_id, at, id`,
    [sessions.map((s) => s.id)],
  );
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!;
    if (t.state !== 'paused') continue;
    const s = sessions.find((x) => x.id === t.session_id)!;
    const next = rows[i + 1];
    const end = next && next.session_id === t.session_id ? Date.parse(next.at) : Date.parse(s.ended_at ?? deps.now().toISOString());
    const a = Math.max(Date.parse(t.at), Date.parse(s.started_at));
    const b = Math.min(end, Date.parse(s.ended_at ?? deps.now().toISOString()));
    if (b > a) out.set(t.session_id, (out.get(t.session_id) ?? 0) + (b - a) / 1000);
  }
  return out;
}

function byProjectName(a: TimesheetProjectRow, b: TimesheetProjectRow): number {
  if (a.project_id === null) return 1;
  if (b.project_id === null) return -1;
  return a.project_name.localeCompare(b.project_name);
}

function addTo(list: TimesheetProjectRow[], s: SessionTime) {
  const row = list.find((p) => p.project_id === s.project_id);
  if (row) row.seconds += s.seconds;
  else list.push({ project_id: s.project_id, project_name: s.project_name, seconds: s.seconds });
}

/** Per-day and per-project totals with overtime for one week. */
export function buildTotals(periodStart: string, sessions: SessionTime[], limits: WorkLimits): TimesheetTotals {
  const days: TimesheetDay[] = weekDates(periodStart).map((date) => ({
    date,
    total_seconds: 0,
    tracked_seconds: 0,
    manual_seconds: 0,
    corrected_seconds: 0,
    overtime_seconds: 0,
    projects: [],
  }));
  const projects: TimesheetProjectRow[] = [];
  for (const s of sessions) {
    const d = days.find((x) => x.date === s.date);
    if (!d) continue;
    d.total_seconds += s.seconds;
    d[`${s.kind}_seconds`] += s.seconds;
    addTo(d.projects, s);
    addTo(projects, s);
  }
  for (const d of days) d.projects.sort(byProjectName);
  projects.sort(byProjectName);
  const ot = computeOvertime(
    days.map((d) => d.total_seconds),
    limits,
  );
  days.forEach((d, i) => (d.overtime_seconds = ot.per_day_seconds[i] ?? 0));
  const sum = (k: 'total_seconds' | 'tracked_seconds' | 'manual_seconds' | 'corrected_seconds') => days.reduce((n, d) => n + d[k], 0);
  return {
    total_seconds: sum('total_seconds'),
    tracked_seconds: sum('tracked_seconds'),
    manual_seconds: sum('manual_seconds'),
    corrected_seconds: sum('corrected_seconds'),
    daily_overtime_seconds: ot.daily_overtime_seconds,
    weekly_overtime_seconds: ot.weekly_overtime_seconds,
    overtime_seconds: ot.overtime_seconds,
    limits,
    days,
    projects,
  };
}

/** Live totals for several weeks of one person (one sessions query per time zone). */
async function liveTotals(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userId: string,
  weeks: { period_start: string; timezone: string }[],
  limits: LimitRow[],
  excludeSessionId: string | null = null,
): Promise<Map<string, TimesheetTotals>> {
  const out = new Map<string, TimesheetTotals>();
  const byZone = new Map<string, string[]>();
  for (const w of weeks) byZone.set(w.timezone, [...(byZone.get(w.timezone) ?? []), w.period_start]);
  for (const [tz, starts] of byZone) {
    const sorted = [...starts].sort();
    const sessions = await sessionTimes(deps, q, orgId, userId, tz, sorted[0]!, addCalendarDays(sorted[sorted.length - 1]!, 7), excludeSessionId);
    for (const w of sorted) {
      const mine = sessions.filter((s) => isoWeekStart(s.date) === w);
      out.set(w, buildTotals(w, mine, plainLimits(resolveLimits(limits, userId, addCalendarDays(w, 6)))));
    }
  }
  return out;
}

// ───────────────────────── timesheet rows ─────────────────────────

interface SheetRow {
  id: string;
  organization_id: string;
  user_id: string;
  period_start: string;
  timezone: string;
  status: TimesheetStatus;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  note: string | null;
  submitted_totals: TimesheetTotals | null;
  approved_totals: TimesheetTotals | null;
}

const SHEET_SELECT = `
  SELECT t.id, t.organization_id, t.user_id, t.period_start::text AS period_start, t.timezone, t.status, t.submitted_at,
         t.reviewed_by, r.display_name AS reviewer_name, t.reviewed_at, t.note, t.submitted_totals, t.approved_totals
  FROM timesheets t LEFT JOIN users r ON r.id = t.reviewed_by`;

async function sheetFor(q: Queryable, orgId: string, userId: string, periodStart: string): Promise<SheetRow | null> {
  return one<SheetRow>(q, `${SHEET_SELECT} WHERE t.organization_id = $1 AND t.user_id = $2 AND t.period_start = $3`, [
    orgId,
    userId,
    periodStart,
  ]);
}

/** The totals that count for a week: frozen at approval, otherwise live. */
function countedTotals(row: SheetRow | undefined, live: TimesheetTotals | undefined): TimesheetTotals | undefined {
  return row?.status === 'approved' && row.approved_totals ? row.approved_totals : live;
}

function totalsKey(t: TimesheetTotals): string {
  return JSON.stringify(t.days.map((d) => [d.date, d.total_seconds, d.projects.map((p) => [p.project_id, p.seconds])]));
}

async function canReview(q: Queryable, actor: UserActor, targetUserId: string): Promise<boolean> {
  if (actor.userId === targetUserId) return false;
  return isAdmin(actor) || isTeamManagerOf(q, actor.userId, targetUserId);
}

async function buildDto(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  actor: UserActor,
  who: Person,
  periodStart: string,
  row: SheetRow | null,
): Promise<TimesheetDTO> {
  const tz = row?.timezone ?? who.timezone;
  const limitData = await limitRows(q, actor.organizationId, [who.id]);
  const limits = resolveLimits(limitData, who.id, addCalendarDays(periodStart, 6));
  const totals = (await liveTotals(deps, q, actor.organizationId, who.id, [{ period_start: periodStart, timezone: tz }], limitData)).get(
    periodStart,
  )!;
  const events = row
    ? await many<TimesheetEventDTO>(
        q,
        `SELECT e.id::text, e.action, e.actor_id, u.display_name AS actor_name, e.note, e.created_at
         FROM timesheet_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.timesheet_id = $1 ORDER BY e.id`,
        [row.id],
      )
    : [];
  const status: TimesheetStatus = row?.status ?? 'draft';
  const started = periodStart <= dateInZone(deps.now(), tz);
  return {
    id: row?.id ?? null,
    user_id: who.id,
    user_name: who.display_name,
    period_start: periodStart,
    period_end: addCalendarDays(periodStart, 6),
    timezone: tz,
    status,
    locked: status === 'approved',
    submitted_at: row?.submitted_at ?? null,
    reviewed_by: row?.reviewed_by ?? null,
    reviewer_name: row?.reviewer_name ?? null,
    reviewed_at: row?.reviewed_at ?? null,
    note: row?.note ?? null,
    totals,
    submitted_totals: row?.submitted_totals ?? null,
    approved_totals: row?.approved_totals ?? null,
    changed_since_submit:
      !!row?.submitted_totals && (status === 'submitted' || status === 'approved') && totalsKey(row.submitted_totals) !== totalsKey(totals),
    limits,
    can_submit: actor.userId === who.id && started && (status === 'draft' || status === 'rejected' || status === 'reopened'),
    can_review: await canReview(q, actor, who.id),
    events,
  };
}

// ───────────────────────── reads ─────────────────────────

function checkWeeks(from: string, to: string): string[] {
  if (to < from) throw errors.validation('to must not be before from');
  const weeks = weeksBetween(from, to);
  if (weeks.length > MAX_WEEKS_PER_QUERY) throw errors.validation(`Range may not exceed ${MAX_WEEKS_PER_QUERY} weeks`);
  return weeks;
}

async function summariesFor(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  who: Person,
  weeks: string[],
): Promise<{ week: string; row: SheetRow | undefined; totals: TimesheetTotals }[]> {
  const rows = await many<SheetRow>(q, `${SHEET_SELECT} WHERE t.organization_id = $1 AND t.user_id = $2 AND t.period_start = ANY($3::date[])`, [
    orgId,
    who.id,
    weeks,
  ]);
  const limitData = await limitRows(q, orgId, [who.id]);
  const needLive = weeks
    .filter((w) => rows.find((r) => r.period_start === w)?.status !== 'approved')
    .map((w) => ({ period_start: w, timezone: rows.find((r) => r.period_start === w)?.timezone ?? who.timezone }));
  const live = await liveTotals(deps, q, orgId, who.id, needLive, limitData);
  return weeks.map((w) => {
    const row = rows.find((r) => r.period_start === w);
    return { week: w, row, totals: countedTotals(row, live.get(w))! };
  });
}

export async function myTimesheets(deps: Deps, q: Queryable, actor: UserActor, from: string, to: string): Promise<TimesheetSummary[]> {
  await requireTimesheets(deps, q, actor.organizationId);
  const weeks = checkWeeks(from, to);
  const who = await person(q, actor.organizationId, actor.userId);
  return (await summariesFor(deps, q, actor.organizationId, who, weeks)).map(({ week, row, totals }) => ({
    id: row?.id ?? null,
    user_id: who.id,
    period_start: week,
    status: row?.status ?? 'draft',
    locked: row?.status === 'approved',
    total_seconds: totals.total_seconds,
    overtime_seconds: totals.overtime_seconds,
    submitted_at: row?.submitted_at ?? null,
    reviewed_at: row?.reviewed_at ?? null,
  }));
}

export async function timesheetFor(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  userId: string,
  periodStart: string,
  requestId?: string,
): Promise<TimesheetDTO> {
  await requireTimesheets(deps, q, actor.organizationId);
  await assertSameOrgUser(q, actor, userId);
  if (userId !== actor.userId) {
    // Same rule as viewing someone's time, plus org admins, who approve timesheets.
    if (!isAdmin(actor)) await assertCanView(deps, q, actor, userId, 'time', { requestId });
    await audit(q, {
      organizationId: actor.organizationId,
      actor,
      action: 'timesheet.view',
      targetType: 'timesheet',
      targetId: periodStart,
      targetUserId: userId,
      requestId,
    });
  }
  const who = await person(q, actor.organizationId, userId);
  return buildDto(deps, q, actor, who, periodStart, await sheetFor(q, actor.organizationId, userId, periodStart));
}

/** Submitted timesheets the actor may review: members of teams they manage (admins: everyone). */
export async function pendingTimesheets(deps: Deps, q: Queryable, actor: UserActor): Promise<TimesheetDTO[]> {
  await requireTimesheets(deps, q, actor.organizationId);
  const rows = await many<SheetRow>(
    q,
    `${SHEET_SELECT} WHERE t.organization_id = $1 AND t.status = 'submitted' AND t.user_id <> $2 AND (
       $3::boolean OR EXISTS (
         SELECT 1 FROM team_memberships m JOIN team_memberships tm ON tm.team_id = m.team_id
         WHERE m.user_id = $2 AND m.role = 'manager' AND m.valid_to IS NULL AND tm.user_id = t.user_id AND tm.valid_to IS NULL))
     ORDER BY t.submitted_at, t.period_start`,
    [actor.organizationId, actor.userId, isAdmin(actor)],
  );
  const out: TimesheetDTO[] = [];
  for (const r of rows) out.push(await buildDto(deps, q, actor, await person(q, actor.organizationId, r.user_id), r.period_start, r));
  return out;
}

// ───────────────────────── state changes ─────────────────────────

async function notify(q: Queryable, orgId: string, userId: string, title: string, body: string) {
  await notifyPeople(q, orgId, [userId], { kind: 'timesheet_review', category: 'my_requests', title, body, link: '/me/time' });
}

async function recordEvent(
  q: Queryable,
  row: { id: string; organization_id: string },
  action: TimesheetEventDTO['action'],
  actorId: string,
  note: string | null,
  totals: TimesheetTotals | null,
  at: string,
) {
  await q.query(
    `INSERT INTO timesheet_events (organization_id, timesheet_id, action, actor_id, note, totals, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.organization_id, row.id, action, actorId, note, totals, at],
  );
}

export async function submitTimesheet(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  periodStart: string,
  note: string | undefined,
  requestId?: string,
): Promise<TimesheetDTO> {
  await requireTimesheets(deps, q, actor.organizationId);
  const who = await person(q, actor.organizationId, actor.userId);
  await q.query(
    `INSERT INTO timesheets (organization_id, user_id, period_start, timezone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id, period_start) DO NOTHING`,
    [actor.organizationId, actor.userId, periodStart, who.timezone],
  );
  const held = await one<{ id: string }>(
    q,
    'SELECT id FROM timesheets WHERE organization_id = $1 AND user_id = $2 AND period_start = $3 FOR UPDATE',
    [actor.organizationId, actor.userId, periodStart],
  );
  const row = (await sheetFor(q, actor.organizationId, actor.userId, periodStart))!;
  if (periodStart > dateInZone(deps.now(), row.timezone)) throw errors.validation("You can't submit a week that hasn't started yet");
  if (row.status === 'submitted') throw errors.conflict('already_submitted', 'This timesheet is already waiting for review');
  if (row.status === 'approved') throw errors.conflict('timesheet_locked', 'This timesheet is approved and locked');

  const dto = await buildDto(deps, q, actor, who, periodStart, row);
  const at = deps.now().toISOString();
  await q.query(
    `UPDATE timesheets SET status = 'submitted', submitted_at = $2, submitted_totals = $3, approved_totals = NULL,
       reviewed_by = NULL, reviewed_at = NULL, note = NULL, updated_at = $2 WHERE id = $1`,
    [held!.id, at, dto.totals],
  );
  await recordEvent(q, row, 'submit', actor.userId, note ?? null, dto.totals, at);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'timesheet.submit',
    targetType: 'timesheet',
    targetId: row.id,
    targetUserId: actor.userId,
    requestId,
    metadata: { period_start: periodStart, total_seconds: dto.totals.total_seconds },
  });
  await publish(q, {
    organizationId: actor.organizationId,
    type: 'timesheet.submitted',
    subjectUserId: actor.userId,
    actorUserId: actor.userId,
    data: { timesheet_id: row.id, user_name: who.display_name, period_start: periodStart },
  });
  return buildDto(deps, q, actor, who, periodStart, await sheetFor(q, actor.organizationId, actor.userId, periodStart));
}

export type ReviewVerb = 'approve' | 'reject' | 'reopen';

const FROM_STATUS: Record<ReviewVerb, TimesheetStatus> = { approve: 'submitted', reject: 'submitted', reopen: 'approved' };
const TO_STATUS: Record<ReviewVerb, TimesheetStatus> = { approve: 'approved', reject: 'rejected', reopen: 'reopened' };

export async function reviewTimesheet(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  verb: ReviewVerb,
  note: string | undefined,
  requestId?: string,
): Promise<TimesheetDTO> {
  await requireTimesheets(deps, q, actor.organizationId);
  const found = await one<{ id: string }>(q, 'SELECT id FROM timesheets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [
    id,
    actor.organizationId,
  ]);
  if (!found) throw errors.notFound('Timesheet');
  const row = (await one<SheetRow>(q, `${SHEET_SELECT} WHERE t.id = $1`, [id]))!;
  if (row.user_id === actor.userId) throw errors.forbidden(`You cannot ${verb} your own timesheet`);
  if (!(await canReview(q, actor, row.user_id))) throw errors.forbidden();
  if (row.status !== FROM_STATUS[verb]) {
    throw errors.conflict('invalid_timesheet_state', `Only a ${FROM_STATUS[verb]} timesheet can be ${verb === 'reopen' ? 'reopened' : `${verb}d`}`);
  }

  const who = await person(q, actor.organizationId, row.user_id);
  const at = deps.now().toISOString();
  let snapshot: TimesheetTotals | null = null;
  if (verb === 'approve') snapshot = (await buildDto(deps, q, actor, who, row.period_start, row)).totals;
  await q.query(
    `UPDATE timesheets SET status = $2, reviewed_by = $3, reviewed_at = $4, note = $5, approved_totals = $6, updated_at = $4 WHERE id = $1`,
    [id, TO_STATUS[verb], actor.userId, at, note ?? null, snapshot],
  );
  await recordEvent(q, row, verb, actor.userId, note ?? null, snapshot, at);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: `timesheet.${verb}`,
    targetType: 'timesheet',
    targetId: id,
    targetUserId: row.user_id,
    requestId,
    metadata: { period_start: row.period_start, ...(snapshot ? { total_seconds: snapshot.total_seconds } : {}) },
  });
  const what = `Your timesheet for the week of ${row.period_start}`;
  const titles: Record<ReviewVerb, string> = {
    approve: `${what} was approved`,
    reject: `${what} was sent back`,
    reopen: `${what} was reopened`,
  };
  const bodies: Record<ReviewVerb, string> = {
    approve: note ? `${actor.displayName}: “${note}”` : `${actor.displayName} approved it. The week is now locked.`,
    reject: `${actor.displayName}: “${note ?? ''}”. Make any corrections and submit it again.`,
    reopen: `${actor.displayName}: “${note ?? ''}”. You can propose corrections for that week again, then resubmit.`,
  };
  await notify(q, actor.organizationId, row.user_id, titles[verb], bodies[verb]);
  return buildDto(deps, q, actor, who, row.period_start, await one<SheetRow>(q, `${SHEET_SELECT} WHERE t.id = $1`, [id]));
}

// ───────────────────────── lock enforcement (used by corrections) ─────────────────────────

/**
 * Refuses changes to time that starts in an approved week (409 timesheet_locked). Pass the
 * start of every session the change touches (the original and the requested start).
 */
export async function assertWeekUnlocked(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userId: string,
  instants: (string | null | undefined)[],
): Promise<void> {
  const list = instants.filter((x): x is string => typeof x === 'string');
  if (list.length === 0) return;
  const hit = await one<{ period_start: string }>(
    q,
    `SELECT period_start::text AS period_start FROM timesheets
     WHERE organization_id = $1 AND user_id = $2 AND status = 'approved'
       AND EXISTS (SELECT 1 FROM unnest($3::timestamptz[]) AS x(at)
                   WHERE x.at >= (period_start::timestamp AT TIME ZONE timezone)
                     AND x.at < ((period_start + 7)::timestamp AT TIME ZONE timezone))
     ORDER BY period_start LIMIT 1`,
    [orgId, userId, list],
  );
  if (!hit) return;
  // Locks are part of the timesheets feature; without it the approved record is kept but not enforced.
  if (!(await timesheetsEnabled(deps, q, orgId))) return;
  throw errors.conflict(
    'timesheet_locked',
    `The timesheet for the week of ${hit.period_start} is approved and locked. Ask your manager to reopen it first.`,
    { period_start: hit.period_start },
  );
}

// ───────────────────────── work limits ─────────────────────────

async function actorToday(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor): Promise<string> {
  const me = await person(q, actor.organizationId, actor.userId);
  return dateInZone(deps.now(), me.timezone);
}

export async function getWorkLimits(deps: Deps, q: Queryable, actor: UserActor): Promise<WorkLimitsResponse> {
  await requireTimesheets(deps, q, actor.organizationId);
  const asOf = await actorToday(deps, q, actor);
  const rows = await many<LimitRow>(
    q,
    `SELECT user_id, daily_minutes, weekly_minutes, effective_from::text AS effective_from FROM work_limits
     WHERE organization_id = $1 ORDER BY effective_from DESC`,
    [actor.organizationId],
  );
  const org = latest(rows, null, asOf);
  const people = await many<{ id: string; display_name: string }>(
    q,
    `SELECT id, display_name FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY display_name`,
    [actor.organizationId, [...new Set(rows.filter((r) => r.user_id).map((r) => r.user_id!))]],
  );
  const users = people
    .map((p) => ({ p, row: latest(rows, p.id, asOf) }))
    .filter(({ row }) => row && (row.daily_minutes !== null || row.weekly_minutes !== null))
    .map(({ p, row }) => ({
      user_id: p.id,
      display_name: p.display_name,
      daily_minutes: row!.daily_minutes,
      weekly_minutes: row!.weekly_minutes,
      effective_from: row!.effective_from,
      effective: resolveLimits(rows, p.id, asOf),
    }));
  return {
    as_of: asOf,
    organization: org ? { daily_minutes: org.daily_minutes, weekly_minutes: org.weekly_minutes, effective_from: org.effective_from } : null,
    users,
    scheduled: rows
      .filter((r) => r.effective_from > asOf)
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
      .map((r) => ({ user_id: r.user_id, effective_from: r.effective_from, daily_minutes: r.daily_minutes, weekly_minutes: r.weekly_minutes })),
  };
}

export async function updateWorkLimits(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  body: WorkLimitsUpdate,
  requestId?: string,
): Promise<WorkLimitsResponse> {
  await requireTimesheets(deps, q, actor.organizationId);
  const effectiveFrom = body.effective_from ?? (await actorToday(deps, q, actor));
  const upsert = (userId: string | null, l: WorkLimits) =>
    q.query(
      `INSERT INTO work_limits (organization_id, user_id, daily_minutes, weekly_minutes, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, user_id, effective_from)
       DO UPDATE SET daily_minutes = EXCLUDED.daily_minutes, weekly_minutes = EXCLUDED.weekly_minutes,
                     created_by = EXCLUDED.created_by, created_at = now()`,
      [actor.organizationId, userId, l.daily_minutes, l.weekly_minutes, effectiveFrom, actor.userId],
    );
  if (body.organization) {
    await upsert(null, body.organization);
    await audit(q, {
      organizationId: actor.organizationId,
      actor,
      action: 'work_limits.update',
      targetType: 'organization',
      targetId: actor.organizationId,
      requestId,
      metadata: { scope: 'organization', effective_from: effectiveFrom, ...body.organization },
    });
  }
  for (const u of body.users ?? []) {
    await assertSameOrgUser(q, actor, u.user_id);
    const l = u.limits ?? { daily_minutes: null, weekly_minutes: null };
    await upsert(u.user_id, l);
    await audit(q, {
      organizationId: actor.organizationId,
      actor,
      action: 'work_limits.update',
      targetType: 'user',
      targetId: u.user_id,
      targetUserId: u.user_id,
      requestId,
      metadata: { scope: 'user', effective_from: effectiveFrom, removed: u.limits === null, ...l },
    });
  }
  return getWorkLimits(deps, q, actor);
}

export async function myWorkLimits(deps: Deps, q: Queryable, actor: UserActor): Promise<MyWorkLimitsResponse> {
  await requireTimesheets(deps, q, actor.organizationId);
  const who = await person(q, actor.organizationId, actor.userId);
  const today = dateInZone(deps.now(), who.timezone);
  const week = isoWeekStart(today);
  const row = await sheetFor(q, actor.organizationId, who.id, week);
  const tz = row?.timezone ?? who.timezone;
  const limitData = await limitRows(q, actor.organizationId, [who.id]);
  const limits = resolveLimits(limitData, who.id, addCalendarDays(week, 6));
  const totals = countedTotals(row ?? undefined, (await liveTotals(deps, q, actor.organizationId, who.id, [{ period_start: week, timezone: tz }], limitData)).get(week))!;
  const day = totals.days.find((d) => d.date === today);
  const worked = day?.total_seconds ?? 0;
  const left = (limitMin: number | null, used: number) => (limitMin === null ? null : Math.max(0, limitMin * 60 - used));
  return {
    timezone: tz,
    limits,
    today: { date: today, worked_seconds: worked, remaining_seconds: left(limits.daily_minutes, worked), overtime_seconds: day?.overtime_seconds ?? 0 },
    week: {
      period_start: week,
      worked_seconds: totals.total_seconds,
      remaining_seconds: left(limits.weekly_minutes, totals.total_seconds),
      overtime_seconds: totals.overtime_seconds,
    },
  };
}

/**
 * Stage 4 F4: limits and time worked so far, for the agent's warnings. `exclude` is the
 * agent's running session, which it counts itself. An approved (locked) week reports its
 * approved totals, which can't include a running session anyway.
 */
export async function deviceWorkLimits(
  deps: Deps,
  q: Queryable,
  device: { organizationId: string; userId: string },
  excludeSessionId: string | null,
): Promise<DeviceWorkLimitsResponse> {
  if (!(await timesheetsEnabled(deps, q, device.organizationId))) return { enabled: false };
  const who = await person(q, device.organizationId, device.userId);
  const now = deps.now();
  const today = dateInZone(now, who.timezone);
  const week = isoWeekStart(today);
  const row = await sheetFor(q, device.organizationId, who.id, week);
  const tz = row?.timezone ?? who.timezone;
  const limitData = await limitRows(q, device.organizationId, [who.id]);
  const limits = resolveLimits(limitData, who.id, today);
  const live = (await liveTotals(deps, q, device.organizationId, who.id, [{ period_start: week, timezone: tz }], limitData, excludeSessionId)).get(week);
  const totals = countedTotals(row ?? undefined, live)!;
  return {
    enabled: true,
    as_of: now.toISOString(),
    timezone: tz,
    daily_minutes: limits.daily_minutes,
    weekly_minutes: limits.weekly_minutes,
    today: { date: today, worked_seconds: totals.days.find((d) => d.date === today)?.total_seconds ?? 0 },
    week: { period_start: week, worked_seconds: totals.total_seconds },
  };
}

// ───────────────────────── team overtime ─────────────────────────

export async function teamOvertime(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  teamId: string,
  from: string,
  to: string,
  requestId?: string,
): Promise<TeamOvertimeReport> {
  await requireTimesheets(deps, q, actor.organizationId);
  const weeks = checkWeeks(from, to);
  const team = await one<{ id: string; name: string }>(q, 'SELECT id, name FROM teams WHERE id = $1 AND organization_id = $2', [
    teamId,
    actor.organizationId,
  ]);
  if (!team) throw errors.notFound('Team');
  const members = await many<Person>(
    q,
    `SELECT u.id, u.display_name, u.timezone FROM team_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND m.valid_to IS NULL AND u.status = 'active' ORDER BY u.display_name`,
    [teamId],
  );
  const lastDay = addCalendarDays(weeks[weeks.length - 1]!, 6);
  const limitData = await limitRows(q, actor.organizationId, members.map((m) => m.id));
  const rows: MemberOvertimeRow[] = [];
  for (const m of members) {
    const who = { ...m, timezone: safeZone(m.timezone) };
    const sums = await summariesFor(deps, q, actor.organizationId, who, weeks);
    const memberWeeks = sums.map(({ week, row, totals }) => ({
      period_start: week,
      status: row?.status ?? ('draft' as const),
      total_seconds: totals.total_seconds,
      daily_overtime_seconds: totals.daily_overtime_seconds,
      weekly_overtime_seconds: totals.weekly_overtime_seconds,
      overtime_seconds: totals.overtime_seconds,
    }));
    rows.push({
      user_id: m.id,
      display_name: m.display_name,
      limits: resolveLimits(limitData, m.id, lastDay),
      total_seconds: memberWeeks.reduce((n, w) => n + w.total_seconds, 0),
      overtime_seconds: memberWeeks.reduce((n, w) => n + w.overtime_seconds, 0),
      weeks: memberWeeks,
    });
    if (m.id !== actor.userId) {
      await audit(q, {
        organizationId: actor.organizationId,
        actor,
        action: 'time.view',
        targetType: 'team_overtime',
        targetId: teamId,
        targetUserId: m.id,
        requestId,
        metadata: { via: 'team_overtime', from: weeks[0], to: lastDay },
      });
    }
  }
  return { team, weeks, members: rows };
}
