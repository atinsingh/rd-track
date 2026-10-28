import { z } from 'zod';
import { uuid } from './events';

/**
 * Weekly timesheets, work limits and overtime (Stage 3, gap analysis §"Stage 3 scope" item 1).
 *
 * A timesheet covers one ISO week (Monday–Sunday) in the employee's time zone. Its hours are
 * tracked agent time plus approved manual and corrected time for sessions that *start* in
 * that week, attributed to the local day the session starts on. Durations are seconds;
 * limits are configured in minutes.
 */

// ───────────────────────── calendar helpers (pure, shared with the web) ─────────────────────────

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateParts(date: string): [number, number, number] | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return [y, mo, d];
}

export function isCalendarDate(date: string): boolean {
  return dateParts(date) !== null;
}

function utcDate(date: string): number {
  const p = dateParts(date);
  if (!p) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}

function fmt(ms: number): string {
  const t = new Date(ms);
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Calendar arithmetic on `YYYY-MM-DD` strings (no time zones involved). */
export function addCalendarDays(date: string, n: number): string {
  return fmt(utcDate(date) + n * DAY_MS);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekdayOf(date: string): number {
  const wd = new Date(utcDate(date)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** The Monday that starts the ISO week containing `date`. */
export function isoWeekStart(date: string): string {
  return addCalendarDays(date, 1 - isoWeekdayOf(date));
}

/** The seven dates of the week starting `periodStart`. */
export function weekDates(periodStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addCalendarDays(periodStart, i));
}

/** Period starts (Mondays) of every ISO week touching [from, to], inclusive. */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const last = isoWeekStart(to);
  for (let w = isoWeekStart(from); w <= last; w = addCalendarDays(w, 7)) out.push(w);
  return out;
}

export const calendarDate = z.string().refine(isCalendarDate, 'Expected a calendar date (YYYY-MM-DD)');
export const periodStartSchema = calendarDate.refine(
  (d) => !isCalendarDate(d) || isoWeekdayOf(d) === 1,
  'A timesheet period starts on a Monday',
);
/** `?from&to` as calendar dates; every ISO week touching the range is returned. */
export const weekRangeQuery = z.object({ from: calendarDate, to: calendarDate });
export const MAX_WEEKS_PER_QUERY = 27;

// ───────────────────────── limits & overtime ─────────────────────────

/** null = no limit (organization default) or "use the organization default" (per-user override). */
export interface WorkLimits {
  daily_minutes: number | null;
  weekly_minutes: number | null;
}

export interface EffectiveWorkLimits extends WorkLimits {
  /** where each value comes from */
  daily_source: 'user' | 'organization' | 'none';
  weekly_source: 'user' | 'organization' | 'none';
}

export interface OvertimeBreakdown {
  /** per day, minutes over the daily limit (same order as the input) */
  per_day_seconds: number[];
  daily_overtime_seconds: number;
  /** time over the weekly limit that was not already counted as daily overtime */
  weekly_overtime_seconds: number;
  overtime_seconds: number;
}

/**
 * Overtime for one week without double counting: daily overtime is time over the daily
 * limit on each day; weekly overtime is the remaining (non-daily-overtime) time over the
 * weekly limit. Total = daily + weekly.
 */
export function computeOvertime(daySeconds: readonly number[], limits: WorkLimits): OvertimeBreakdown {
  const dailyCap = limits.daily_minutes === null ? null : limits.daily_minutes * 60;
  const perDay = daySeconds.map((s) => (dailyCap === null ? 0 : Math.max(0, Math.round(s) - dailyCap)));
  const daily = perDay.reduce((a, b) => a + b, 0);
  const total = daySeconds.reduce((a, b) => a + Math.round(b), 0);
  const weekly = limits.weekly_minutes === null ? 0 : Math.max(0, total - daily - limits.weekly_minutes * 60);
  return { per_day_seconds: perDay, daily_overtime_seconds: daily, weekly_overtime_seconds: weekly, overtime_seconds: daily + weekly };
}

const limitValues = z.strictObject({
  daily_minutes: z.number().int().min(1).max(24 * 60).nullable(),
  weekly_minutes: z.number().int().min(1).max(7 * 24 * 60).nullable(),
});

/**
 * PUT /v1/admin/work-limits. `organization` sets the default; each `users` entry sets a
 * per-person override (a null field inherits the organization default; `limits: null`
 * removes the override). Changes apply from `effective_from` (default: today).
 */
export const workLimitsUpdateRequest = z.strictObject({
  effective_from: calendarDate.optional(),
  organization: limitValues.optional(),
  users: z
    .array(z.strictObject({ user_id: uuid, limits: limitValues.nullable() }))
    .max(500)
    .optional(),
});
export type WorkLimitsUpdate = z.infer<typeof workLimitsUpdateRequest>;

export interface WorkLimitOverride extends WorkLimits {
  user_id: string;
  display_name: string;
  effective_from: string;
  effective: EffectiveWorkLimits;
}

/** GET /v1/admin/work-limits: what applies today, plus scheduled changes. */
export interface WorkLimitsResponse {
  as_of: string;
  organization: (WorkLimits & { effective_from: string | null }) | null;
  users: WorkLimitOverride[];
  scheduled: { user_id: string | null; effective_from: string; daily_minutes: number | null; weekly_minutes: number | null }[];
}

/** GET /v1/me/work-limits: the data an agent or the web uses to warn before a limit. */
export interface MyWorkLimitsResponse {
  timezone: string;
  limits: EffectiveWorkLimits;
  today: { date: string; worked_seconds: number; remaining_seconds: number | null; overtime_seconds: number };
  week: { period_start: string; worked_seconds: number; remaining_seconds: number | null; overtime_seconds: number };
}

// ───────────────────────── timesheets ─────────────────────────

export const TIMESHEET_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'reopened'] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

export interface TimesheetProjectRow {
  project_id: string | null;
  project_name: string;
  seconds: number;
}

export interface TimesheetDay {
  date: string;
  total_seconds: number;
  tracked_seconds: number;
  manual_seconds: number;
  corrected_seconds: number;
  overtime_seconds: number;
  projects: TimesheetProjectRow[];
}

export interface TimesheetTotals {
  total_seconds: number;
  /** agent time that has not been corrected */
  tracked_seconds: number;
  /** approved manual entries */
  manual_seconds: number;
  /** agent sessions whose start/end were changed by an approved correction */
  corrected_seconds: number;
  daily_overtime_seconds: number;
  weekly_overtime_seconds: number;
  overtime_seconds: number;
  /** the limits these overtime figures were computed with */
  limits: WorkLimits;
  /** always seven days, Monday first */
  days: TimesheetDay[];
  /** whole week per project, by name */
  projects: TimesheetProjectRow[];
}

export interface TimesheetEventDTO {
  id: string;
  action: 'submit' | 'approve' | 'reject' | 'reopen';
  actor_id: string | null;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

export interface TimesheetDTO {
  /** null until the week is first submitted */
  id: string | null;
  user_id: string;
  user_name: string;
  period_start: string;
  period_end: string;
  timezone: string;
  status: TimesheetStatus;
  /** approved weeks refuse corrections and manual time (409 timesheet_locked) */
  locked: boolean;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  /** the latest reviewer's note */
  note: string | null;
  /** live totals from the current records */
  totals: TimesheetTotals;
  /** what the employee submitted */
  submitted_totals: TimesheetTotals | null;
  /** frozen at approval; the record payroll uses */
  approved_totals: TimesheetTotals | null;
  /** live totals differ from what was submitted (e.g. a correction was approved since) */
  changed_since_submit: boolean;
  limits: EffectiveWorkLimits;
  /** for the requester */
  can_submit: boolean;
  can_review: boolean;
  events: TimesheetEventDTO[];
}

export interface TimesheetSummary {
  id: string | null;
  user_id: string;
  period_start: string;
  status: TimesheetStatus;
  locked: boolean;
  total_seconds: number;
  overtime_seconds: number;
  submitted_at: string | null;
  reviewed_at: string | null;
}

export const timesheetSubmitRequest = z.strictObject({ note: z.string().trim().max(1000).optional() });
export const timesheetApproveRequest = z.strictObject({ note: z.string().trim().max(1000).optional() });
/** Rejecting or reopening tells the employee why. */
export const timesheetNoteRequiredRequest = z.strictObject({ note: z.string().trim().min(3).max(1000) });

// ───────────────────────── team overtime ─────────────────────────

export interface OvertimeWeek {
  period_start: string;
  status: TimesheetStatus;
  total_seconds: number;
  daily_overtime_seconds: number;
  weekly_overtime_seconds: number;
  overtime_seconds: number;
}

export interface MemberOvertimeRow {
  user_id: string;
  display_name: string;
  limits: EffectiveWorkLimits;
  total_seconds: number;
  overtime_seconds: number;
  weeks: OvertimeWeek[];
}

/** GET /v1/teams/{id}/overtime?from&to (dates). Sorted by name; never ranked. */
export interface TeamOvertimeReport {
  team: { id: string; name: string };
  weeks: string[];
  members: MemberOvertimeRow[];
}
