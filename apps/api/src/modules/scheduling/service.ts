import {
  calendarDate,
  hasEntitlement,
  type AttendanceResponse,
  type HolidayDTO,
  type MyScheduleResponse,
  type SchedulingSettingsDTO,
  type ShiftDTO,
  type ShiftOverrideDTO,
  type TeamAttendanceResponse,
  type TeamCalendarResponse,
} from '@rd/contracts';
import type { z } from 'zod';
import type { DeviceScheduleTodayResponse, NotificationCategory } from '@rd/contracts';
import type { shiftCreateRequest, shiftOverrideRequest, shiftUpdateRequest, holidayCreateRequest } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { notify as notifyPeople } from '../engine/notify';
import { currentSubscription } from '../billing/service';
import { attendanceDay, leaveOn, scheduleDay, summarize, type LeaveRow, type OverrideRow, type PersonCalendar, type SessionSpan, type Settings, type ShiftRow } from './attendance';
import { addDays, dateInTz, daysBetween, eachDate, isValidTimeZone, utcMidnight } from './tz';

// ───────────── plan gates ─────────────

export type SchedulingEntitlement = 'schedules' | 'time_off';

const GATE_MESSAGE: Record<SchedulingEntitlement, string> = {
  schedules: 'Schedules and attendance are part of the Pro plan.',
  time_off: 'Time off is part of the Standard and Pro plans.',
};

export async function entitlementsOf(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string): Promise<Record<SchedulingEntitlement, boolean>> {
  const sub = await currentSubscription(q, orgId, deps.now());
  const has = (e: SchedulingEntitlement) => sub.status === 'trialing' || hasEntitlement(sub.plan, e);
  return { schedules: has('schedules'), time_off: has('time_off') };
}

/** 402 plan_upgrade_required unless the organization's plan includes one of `es`. */
export async function requireEntitlement(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, ...es: SchedulingEntitlement[]) {
  const got = await entitlementsOf(deps, q, orgId);
  if (!es.some((e) => got[e])) throw errors.paymentRequired(GATE_MESSAGE[es[0]!]);
  return got;
}

// ───────────── inputs ─────────────

/** Inclusive calendar-day range `from`..`to` (YYYY-MM-DD). */
export function parseDateRange(qs: { from?: unknown; to?: unknown }, maxDays = 62): { from: string; to: string } {
  const f = calendarDate.safeParse(qs.from);
  const t = calendarDate.safeParse(qs.to);
  if (!f.success || !t.success || t.data < f.data) throw errors.validation('from and to must be dates YYYY-MM-DD with from ≤ to');
  if (daysBetween(f.data, t.data) + 1 > maxDays) throw errors.validation(`Range may not exceed ${maxDays} days`);
  return { from: f.data, to: t.data };
}

async function userTimezone(q: Queryable, orgId: string, userId: string): Promise<string> {
  const u = await one<{ timezone: string }>(q, 'SELECT timezone FROM users WHERE id = $1 AND organization_id = $2', [userId, orgId]);
  if (!u) throw errors.notFound('User');
  return isValidTimeZone(u.timezone) ? u.timezone : 'UTC';
}

export async function todayFor(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, userId: string): Promise<string> {
  return dateInTz(deps.now().getTime(), await userTimezone(q, orgId, userId));
}

const NOTICE_ROUTE: Record<string, { category: NotificationCategory; link: string }> = {
  schedule_change: { category: 'schedule', link: '/me/schedule' },
  time_off_adjustment: { category: 'schedule', link: '/me/schedule' },
  time_off_request: { category: 'approvals', link: '/approvals' },
  time_off_review: { category: 'my_requests', link: '/me/schedule' },
};

/** Scheduling and time-off notices go through the one notification service. */
export async function notify(q: Queryable, orgId: string, userId: string, kind: string, title: string, body: string) {
  const route = NOTICE_ROUTE[kind] ?? { category: 'my_requests' as const, link: '/me/schedule' };
  await notifyPeople(q, orgId, [userId], { kind, title, body, ...route });
}

// ───────────── settings ─────────────

export async function getSettings(q: Queryable, orgId: string): Promise<SchedulingSettingsDTO> {
  const r = await one<SchedulingSettingsDTO>(
    q,
    'SELECT late_grace_minutes, early_leave_grace_minutes, default_day_hours FROM scheduling_settings WHERE organization_id = $1',
    [orgId],
  );
  return r ?? { late_grace_minutes: 10, early_leave_grace_minutes: 10, default_day_hours: 8 };
}

export async function updateSettings(q: Queryable, actor: UserActor, patch: Partial<SchedulingSettingsDTO>, requestId?: string) {
  const cur = await getSettings(q, actor.organizationId);
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as SchedulingSettingsDTO;
  await q.query(
    `INSERT INTO scheduling_settings (organization_id, late_grace_minutes, early_leave_grace_minutes, default_day_hours)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id) DO UPDATE SET late_grace_minutes = $2, early_leave_grace_minutes = $3, default_day_hours = $4, updated_at = now()`,
    [actor.organizationId, next.late_grace_minutes, next.early_leave_grace_minutes, next.default_day_hours],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'scheduling.settings_update', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { ...next } });
  return getSettings(q, actor.organizationId);
}

// ───────────── loading calendars ─────────────

const TIME = (col: string) => `to_char(${col}, 'HH24:MI')`;

/**
 * Shifts, overrides, holidays, approved leave and (optionally) sessions for several people
 * over `from`..`to`, in a handful of queries.
 */
export async function loadCalendars(
  q: Queryable,
  orgId: string,
  userIds: string[],
  from: string,
  to: string,
  opts: { sessions?: boolean } = {},
): Promise<Map<string, PersonCalendar>> {
  const out = new Map<string, PersonCalendar>();
  for (const id of userIds) out.set(id, { shifts: [], overrides: new Map(), holidays: new Map(), leave: [], sessions: [] });
  if (userIds.length === 0) return out;

  const shifts = await many<ShiftRow & { user_id: string }>(
    q,
    `SELECT id, user_id, timezone, weekdays, ${TIME('start_time')} AS start_time, ${TIME('end_time')} AS end_time, effective_from, effective_to
     FROM shifts WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND effective_from <= $4 AND (effective_to IS NULL OR effective_to >= $3)
     ORDER BY effective_from DESC`,
    [orgId, userIds, from, to],
  );
  for (const s of shifts) out.get(s.user_id)!.shifts.push({ ...s, weekdays: s.weekdays.map(Number) });

  const overrides = await many<OverrideRow & { user_id: string }>(
    q,
    `SELECT user_id, date, kind, timezone, ${TIME('start_time')} AS start_time, ${TIME('end_time')} AS end_time
     FROM shift_overrides WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND date BETWEEN $3 AND $4`,
    [orgId, userIds, from, to],
  );
  for (const o of overrides) out.get(o.user_id)!.overrides.set(o.date, o);

  const holidays = await many<{ date: string; name: string; team_id: string | null }>(
    q,
    `SELECT date, name, team_id FROM holidays WHERE organization_id = $1 AND date BETWEEN $2 AND $3 ORDER BY team_id NULLS FIRST`,
    [orgId, from, to],
  );
  if (holidays.length) {
    const teams = await many<{ user_id: string; team_id: string }>(
      q,
      `SELECT user_id, team_id FROM team_memberships WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND valid_to IS NULL`,
      [orgId, userIds],
    );
    for (const [uid, cal] of out) {
      const mine = new Set(teams.filter((t) => t.user_id === uid).map((t) => t.team_id));
      for (const h of holidays) {
        if (h.team_id && !mine.has(h.team_id)) continue;
        if (!cal.holidays.has(h.date)) cal.holidays.set(h.date, h.name);
      }
    }
  }

  const leave = await many<LeaveRow & { user_id: string }>(
    q,
    `SELECT user_id, start_date, end_date, partial_hours FROM time_off_requests
     WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'approved' AND start_date <= $4 AND end_date >= $3`,
    [orgId, userIds, from, to],
  );
  for (const l of leave) out.get(l.user_id)!.leave.push(l);

  if (opts.sessions) {
    // Coarse bounds (a day either side) cover every time zone and overnight shifts.
    const sessions = await many<SessionSpan & { user_id: string }>(
      q,
      `SELECT user_id, started_at, ended_at FROM work_sessions
       WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND started_at < $4 AND (ended_at IS NULL OR ended_at > $3)
       ORDER BY started_at`,
      [orgId, userIds, new Date(utcMidnight(from) - 2 * 86_400_000).toISOString(), new Date(utcMidnight(to) + 3 * 86_400_000).toISOString()],
    );
    for (const s of sessions) out.get(s.user_id)!.sessions.push(s);
  }
  return out;
}

function settingsOf(s: SchedulingSettingsDTO): Settings {
  return { late_grace_minutes: s.late_grace_minutes, early_leave_grace_minutes: s.early_leave_grace_minutes, default_day_hours: Number(s.default_day_hours) };
}

// ───────────── reads: me / team ─────────────

const SHIFT_SELECT = `
  SELECT s.id, s.user_id, u.display_name AS user_name, s.timezone, s.weekdays,
         ${TIME('s.start_time')} AS start_time, ${TIME('s.end_time')} AS end_time, s.end_time <= s.start_time AS overnight,
         s.effective_from, s.effective_to, s.created_at
  FROM shifts s JOIN users u ON u.id = s.user_id`;

function shiftDto(r: ShiftDTO): ShiftDTO {
  return { ...r, weekdays: r.weekdays.map(Number) };
}

export async function mySchedule(q: Queryable, actor: UserActor, r: { from: string; to: string }): Promise<MyScheduleResponse> {
  const tz = await userTimezone(q, actor.organizationId, actor.userId);
  const cal = (await loadCalendars(q, actor.organizationId, [actor.userId], r.from, r.to)).get(actor.userId)!;
  const shifts = (
    await many<ShiftDTO>(q, `${SHIFT_SELECT} WHERE s.organization_id = $1 AND s.user_id = $2 AND (s.effective_to IS NULL OR s.effective_to >= $3) ORDER BY s.effective_from`, [
      actor.organizationId,
      actor.userId,
      r.from,
    ])
  ).map(shiftDto);
  return { from: r.from, to: r.to, timezone: tz, shifts, days: eachDate(r.from, r.to).map((d) => scheduleDay(cal, d)) };
}

export async function attendanceFor(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, userId: string, r: { from: string; to: string }): Promise<AttendanceResponse> {
  const settings = await getSettings(q, orgId);
  const cal = (await loadCalendars(q, orgId, [userId], r.from, r.to, { sessions: true })).get(userId)!;
  const now = deps.now().getTime();
  const days = eachDate(r.from, r.to).map((d) => attendanceDay(cal, d, settingsOf(settings), now));
  return {
    user_id: userId,
    from: r.from,
    to: r.to,
    late_grace_minutes: settings.late_grace_minutes,
    early_leave_grace_minutes: settings.early_leave_grace_minutes,
    days,
    summary: summarize(days),
  };
}

async function teamMembers(q: Queryable, orgId: string, teamId: string) {
  const team = await one<{ id: string; name: string }>(q, 'SELECT id, name FROM teams WHERE id = $1 AND organization_id = $2', [teamId, orgId]);
  if (!team) throw errors.notFound('Team');
  const members = await many<{ user_id: string; display_name: string }>(
    q,
    `SELECT u.id AS user_id, u.display_name FROM team_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND m.valid_to IS NULL AND u.status = 'active' ORDER BY lower(u.display_name), u.id`,
    [teamId],
  );
  return { team, members };
}

export async function teamAttendance(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, teamId: string, r: { from: string; to: string }): Promise<TeamAttendanceResponse> {
  const { team, members } = await teamMembers(q, orgId, teamId);
  const settings = await getSettings(q, orgId);
  const cals = await loadCalendars(q, orgId, members.map((m) => m.user_id), r.from, r.to, { sessions: true });
  const now = deps.now().getTime();
  return {
    team,
    from: r.from,
    to: r.to,
    late_grace_minutes: settings.late_grace_minutes,
    early_leave_grace_minutes: settings.early_leave_grace_minutes,
    members: members.map((m) => {
      const days = eachDate(r.from, r.to).map((d) => attendanceDay(cals.get(m.user_id)!, d, settingsOf(settings), now));
      return { ...m, days, summary: summarize(days) };
    }),
  };
}

export async function teamCalendar(
  q: Queryable,
  orgId: string,
  teamId: string,
  r: { from: string; to: string },
  includes: { schedules: boolean; time_off: boolean },
): Promise<TeamCalendarResponse> {
  const { team, members } = await teamMembers(q, orgId, teamId);
  const settings = settingsOf(await getSettings(q, orgId));
  const cals = await loadCalendars(q, orgId, members.map((m) => m.user_id), r.from, r.to);
  return {
    team,
    from: r.from,
    to: r.to,
    includes,
    members: members.map((m) => {
      const cal = cals.get(m.user_id)!;
      return {
        ...m,
        days: eachDate(r.from, r.to).map((date) => {
          const day = scheduleDay(cal, date);
          const leave = includes.time_off ? leaveOn(cal, date, settings) : null;
          return {
            date,
            shift: includes.schedules && day.shift ? { start_time: day.shift.start_time, end_time: day.shift.end_time, timezone: day.shift.timezone } : null,
            off: leave && leave.hours > 0 ? leave : null,
            holiday: day.holiday,
          };
        }),
      };
    }),
  };
}

// ───────────── shifts (admin) ─────────────

type ShiftCreate = z.infer<typeof shiftCreateRequest>;
type ShiftUpdate = z.infer<typeof shiftUpdateRequest>;

async function assertNoShiftOverlap(q: Queryable, userId: string, excludeId: string | null, s: { weekdays: number[]; effective_from: string; effective_to: string | null }) {
  const clash = await one(
    q,
    `SELECT 1 FROM shifts WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2) AND weekdays && $3::smallint[]
       AND effective_from <= COALESCE($5::date, 'infinity'::date) AND COALESCE(effective_to, 'infinity'::date) >= $4::date LIMIT 1`,
    [userId, excludeId, s.weekdays, s.effective_from, s.effective_to],
  );
  if (clash) throw errors.conflict('shift_overlap', 'This person already has a shift on one of these weekdays in that period');
}

export async function listShifts(q: Queryable, orgId: string, userId?: string): Promise<ShiftDTO[]> {
  return (
    await many<ShiftDTO>(q, `${SHIFT_SELECT} WHERE s.organization_id = $1 AND ($2::uuid IS NULL OR s.user_id = $2) ORDER BY lower(u.display_name), s.effective_from`, [
      orgId,
      userId ?? null,
    ])
  ).map(shiftDto);
}

async function getShift(q: Queryable, orgId: string, id: string): Promise<ShiftDTO> {
  const r = await one<ShiftDTO>(q, `${SHIFT_SELECT} WHERE s.id = $1 AND s.organization_id = $2`, [id, orgId]);
  if (!r) throw errors.notFound('Shift');
  return shiftDto(r);
}

export async function createShift(q: Queryable, actor: UserActor, input: ShiftCreate, requestId?: string): Promise<ShiftDTO> {
  // Also the 404 for a user in another organization.
  const tz = input.timezone ?? (await userTimezone(q, actor.organizationId, input.user_id));
  if (input.timezone) await userTimezone(q, actor.organizationId, input.user_id);
  const s = { weekdays: input.weekdays, effective_from: input.effective_from, effective_to: input.effective_to ?? null };
  await assertNoShiftOverlap(q, input.user_id, null, s);
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO shifts (organization_id, user_id, timezone, weekdays, start_time, end_time, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.organizationId, input.user_id, tz, input.weekdays, input.start_time, input.end_time, s.effective_from, s.effective_to, actor.userId],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'shift.create', targetType: 'shift', targetId: r!.id, targetUserId: input.user_id, requestId });
  await notify(q, actor.organizationId, input.user_id, 'schedule_change', 'Your schedule was updated', 'A recurring shift was added to your schedule. See My schedule for details.');
  return getShift(q, actor.organizationId, r!.id);
}

export async function updateShift(q: Queryable, actor: UserActor, id: string, patch: ShiftUpdate, requestId?: string): Promise<ShiftDTO> {
  const cur = await getShift(q, actor.organizationId, id);
  const next = {
    timezone: patch.timezone ?? cur.timezone,
    weekdays: patch.weekdays ?? cur.weekdays,
    start_time: patch.start_time ?? cur.start_time,
    end_time: patch.end_time ?? cur.end_time,
    effective_from: patch.effective_from ?? cur.effective_from,
    effective_to: patch.effective_to === undefined ? cur.effective_to : patch.effective_to,
  };
  if (next.start_time === next.end_time) throw errors.validation('Start and end must differ');
  if (next.effective_to && next.effective_to < next.effective_from) throw errors.validation('Ends before it starts');
  await assertNoShiftOverlap(q, cur.user_id, id, next);
  await q.query(
    `UPDATE shifts SET timezone = $2, weekdays = $3, start_time = $4, end_time = $5, effective_from = $6, effective_to = $7, updated_at = now() WHERE id = $1`,
    [id, next.timezone, next.weekdays, next.start_time, next.end_time, next.effective_from, next.effective_to],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'shift.update', targetType: 'shift', targetId: id, targetUserId: cur.user_id, requestId });
  await notify(q, actor.organizationId, cur.user_id, 'schedule_change', 'Your schedule was updated', 'One of your recurring shifts changed. See My schedule for details.');
  return getShift(q, actor.organizationId, id);
}

/** Future shifts are deleted; a shift that has started is ended yesterday so past attendance keeps its basis. */
export async function removeShift(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<{ ended: boolean }> {
  const cur = await getShift(q, actor.organizationId, id);
  const today = dateInTz(deps.now().getTime(), cur.timezone);
  let ended = false;
  if (cur.effective_from >= today) {
    await q.query('DELETE FROM shifts WHERE id = $1', [id]);
  } else {
    const yesterday = addDays(today, -1);
    if (!cur.effective_to || cur.effective_to > yesterday) await q.query('UPDATE shifts SET effective_to = $2, updated_at = now() WHERE id = $1', [id, yesterday]);
    ended = true;
  }
  await audit(q, { organizationId: actor.organizationId, actor, action: ended ? 'shift.end' : 'shift.delete', targetType: 'shift', targetId: id, targetUserId: cur.user_id, requestId });
  return { ended };
}

// ───────────── overrides (admin) ─────────────

const OVERRIDE_SELECT = `
  SELECT o.id, o.user_id, u.display_name AS user_name, o.date, o.kind, o.timezone,
         ${TIME('o.start_time')} AS start_time, ${TIME('o.end_time')} AS end_time, o.note, o.created_at
  FROM shift_overrides o JOIN users u ON u.id = o.user_id`;

export async function listOverrides(q: Queryable, orgId: string, f: { from: string; to: string; userId?: string }): Promise<ShiftOverrideDTO[]> {
  return many<ShiftOverrideDTO>(
    q,
    `${OVERRIDE_SELECT} WHERE o.organization_id = $1 AND o.date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR o.user_id = $4) ORDER BY o.date, lower(u.display_name)`,
    [orgId, f.from, f.to, f.userId ?? null],
  );
}

export async function upsertOverride(q: Queryable, actor: UserActor, input: z.infer<typeof shiftOverrideRequest>, requestId?: string): Promise<ShiftOverrideDTO> {
  const userTz = await userTimezone(q, actor.organizationId, input.user_id);
  // The override uses the time zone of the shift it replaces (or the person's profile zone).
  const shift = await one<{ timezone: string }>(
    q,
    `SELECT timezone FROM shifts WHERE user_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2) ORDER BY effective_from DESC LIMIT 1`,
    [input.user_id, input.date],
  );
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO shift_overrides (organization_id, user_id, date, kind, timezone, start_time, end_time, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, date) DO UPDATE SET kind = $4, timezone = $5, start_time = $6, end_time = $7, note = $8, created_by = $9, created_at = now()
     RETURNING id`,
    [
      actor.organizationId,
      input.user_id,
      input.date,
      input.kind,
      shift?.timezone ?? userTz,
      input.kind === 'change' ? input.start_time : null,
      input.kind === 'change' ? input.end_time : null,
      input.note ?? null,
      actor.userId,
    ],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'shift_override.set', targetType: 'shift_override', targetId: r!.id, targetUserId: input.user_id, requestId, metadata: { date: input.date, kind: input.kind } });
  await notify(
    q,
    actor.organizationId,
    input.user_id,
    'schedule_change',
    input.kind === 'cancel' ? `No shift on ${input.date}` : `Your shift on ${input.date} changed`,
    input.kind === 'cancel' ? 'Your usual shift for that day was cancelled.' : `New time: ${input.start_time}–${input.end_time}.`,
  );
  return (await one<ShiftOverrideDTO>(q, `${OVERRIDE_SELECT} WHERE o.id = $1`, [r!.id]))!;
}

export async function deleteOverride(q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await one<{ user_id: string }>(q, 'DELETE FROM shift_overrides WHERE id = $1 AND organization_id = $2 RETURNING user_id', [id, actor.organizationId]);
  if (!r) throw errors.notFound('Shift override');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'shift_override.delete', targetType: 'shift_override', targetId: id, targetUserId: r.user_id, requestId });
}

// ───────────── holidays (admin) ─────────────

const HOLIDAY_SELECT = `SELECT h.id, h.date, h.name, h.team_id, t.name AS team_name FROM holidays h LEFT JOIN teams t ON t.id = h.team_id`;

export async function listHolidays(q: Queryable, orgId: string, year?: string): Promise<HolidayDTO[]> {
  return many<HolidayDTO>(
    q,
    `${HOLIDAY_SELECT} WHERE h.organization_id = $1 AND ($2::text IS NULL OR to_char(h.date, 'YYYY') = $2) ORDER BY h.date, t.name NULLS FIRST`,
    [orgId, year ?? null],
  );
}

export async function createHoliday(q: Queryable, actor: UserActor, input: z.infer<typeof holidayCreateRequest>, requestId?: string): Promise<HolidayDTO> {
  if (input.team_id) {
    const t = await one(q, 'SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2', [input.team_id, actor.organizationId]);
    if (!t) throw errors.validation('Unknown team');
  }
  const dup = await one(
    q,
    `SELECT 1 FROM holidays WHERE organization_id = $1 AND date = $2 AND team_id IS NOT DISTINCT FROM $3::uuid`,
    [actor.organizationId, input.date, input.team_id ?? null],
  );
  if (dup) throw errors.conflict('holiday_exists', 'There is already a holiday on this date');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO holidays (organization_id, date, name, team_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [actor.organizationId, input.date, input.name, input.team_id ?? null, actor.userId],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'holiday.create', targetType: 'holiday', targetId: r!.id, requestId, metadata: { date: input.date } });
  return (await one<HolidayDTO>(q, `${HOLIDAY_SELECT} WHERE h.id = $1`, [r!.id]))!;
}

export async function deleteHoliday(q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await one(q, 'DELETE FROM holidays WHERE id = $1 AND organization_id = $2 RETURNING id', [id, actor.organizationId]);
  if (!r) throw errors.notFound('Holiday');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'holiday.delete', targetType: 'holiday', targetId: id, requestId });
}

// ───────────── Stage 4 F3: the agent's reminder window ─────────────

/**
 * Today's working hours for the device's user. Shifts count only while the plan has
 * schedules; a holiday, a cancelled shift or approved full-day leave means no reminders.
 */
export async function deviceScheduleToday(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  device: { organizationId: string; userId: string },
): Promise<DeviceScheduleTodayResponse> {
  const timezone = await userTimezone(q, device.organizationId, device.userId);
  const date = dateInTz(deps.now().getTime(), timezone);
  const cal = (await loadCalendars(q, device.organizationId, [device.userId], date, date)).get(device.userId)!;
  const { schedules } = await entitlementsOf(deps, q, device.organizationId);
  if (!schedules) cal.shifts = [];
  if (!schedules) cal.overrides = new Map();
  const day = scheduleDay(cal, date);
  const leave = leaveOn(cal, date, settingsOf(await getSettings(q, device.organizationId)));
  const day_off = day.holiday ? 'holiday' : day.cancelled ? 'cancelled' : leave && !leave.partial ? 'leave' : null;
  return {
    date,
    timezone,
    scheduled: schedules && cal.shifts.length > 0,
    shift: day.shift ? { start_at: day.shift.start_at, end_at: day.shift.end_at } : null,
    day_off,
  };
}
