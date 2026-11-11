import { z } from 'zod';
import { uuid } from './events';
import { calendarDate } from './timesheets';

/**
 * Schedules, attendance, time off and holidays (Stage 3, gap analysis item 3).
 *
 * Calendar days are `YYYY-MM-DD` strings in the person's schedule time zone, wall-clock
 * times are `HH:MM`, and instants are RFC 3339 UTC. Attendance describes the schedule,
 * not performance: it says whether time was recorded during a scheduled shift.
 */

// ───────────────────────── primitives ─────────────────────────

export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time HH:MM');
const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');
const hours = z.number().min(0).max(10_000);

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const isoWeekdaySchema = z.int().min(1).max(7);

/** Minutes after midnight of `HH:MM`. */
export function minutesOfDay(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** A shift ends the next day when its end time is not after its start time. */
export function isOvernight(start: string, end: string): boolean {
  return minutesOfDay(end) <= minutesOfDay(start);
}

/** Nominal (wall-clock) length of a shift in hours, e.g. 22:00–06:00 = 8. */
export function shiftHours(start: string, end: string): number {
  const d = minutesOfDay(end) - minutesOfDay(start);
  return (d > 0 ? d : d + 24 * 60) / 60;
}

/** "7.5 h", "8 h" */
export function formatHours(h: number): string {
  const r = Math.round(h * 100) / 100;
  return `${Number.isInteger(r) ? r.toFixed(0) : String(r)} h`;
}

// ───────────────────────── settings ─────────────────────────

export interface SchedulingSettingsDTO {
  /** a first session starting later than shift start + this is "late" */
  late_grace_minutes: number;
  /** a last session ending earlier than shift end − this is "left early" */
  early_leave_grace_minutes: number;
  /** hours one full day of leave costs on a weekday when the person has no shift */
  default_day_hours: number;
}
export const schedulingSettingsUpdate = z.strictObject({
  late_grace_minutes: z.int().min(0).max(240).optional(),
  early_leave_grace_minutes: z.int().min(0).max(240).optional(),
  default_day_hours: z.number().gt(0).max(24).optional(),
});

// ───────────────────────── shifts ─────────────────────────

const weekdays = z
  .array(isoWeekdaySchema)
  .min(1)
  .max(7)
  .refine((xs) => new Set(xs).size === xs.length, 'Weekdays must not repeat');

export const shiftCreateRequest = z
  .strictObject({
    user_id: uuid,
    /** defaults to the person's profile time zone */
    timezone: timeZone.optional(),
    weekdays,
    start_time: clockTime,
    end_time: clockTime,
    effective_from: calendarDate,
    effective_to: calendarDate.nullable().optional(),
  })
  .refine((v) => v.start_time !== v.end_time, { message: 'Start and end must differ', path: ['end_time'] })
  .refine((v) => !v.effective_to || v.effective_to >= v.effective_from, { message: 'Ends before it starts', path: ['effective_to'] });

export const shiftUpdateRequest = z.strictObject({
  timezone: timeZone.optional(),
  weekdays: weekdays.optional(),
  start_time: clockTime.optional(),
  end_time: clockTime.optional(),
  effective_from: calendarDate.optional(),
  effective_to: calendarDate.nullable().optional(),
});

export interface ShiftDTO {
  id: string;
  user_id: string;
  user_name: string;
  timezone: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  overnight: boolean;
  effective_from: string;
  /** inclusive last day; null = open-ended */
  effective_to: string | null;
  created_at: string;
}

export const shiftOverrideRequest = z
  .strictObject({
    user_id: uuid,
    date: calendarDate,
    kind: z.enum(['change', 'cancel']),
    start_time: clockTime.optional(),
    end_time: clockTime.optional(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.kind === 'cancel' || (v.start_time && v.end_time && v.start_time !== v.end_time), {
    message: 'A changed shift needs a start and an end',
    path: ['start_time'],
  });

export interface ShiftOverrideDTO {
  id: string;
  user_id: string;
  user_name: string;
  date: string;
  kind: 'change' | 'cancel';
  timezone: string;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
  created_at: string;
}

/** One concrete shift on one day, resolved from the recurring schedule and overrides. */
export interface ScheduledShift {
  /** the day the shift starts on */
  date: string;
  timezone: string;
  start_time: string;
  end_time: string;
  start_at: string;
  end_at: string;
  overnight: boolean;
  source: 'shift' | 'override';
  shift_id: string | null;
}

export interface ScheduleDay {
  date: string;
  shift: ScheduledShift | null;
  /** a one-off cancellation of the usual shift */
  cancelled: boolean;
  holiday: string | null;
}

export interface MyScheduleResponse {
  from: string;
  to: string;
  timezone: string;
  shifts: ShiftDTO[];
  days: ScheduleDay[];
}

// ───────────────────────── attendance ─────────────────────────

export const ATTENDANCE_STATUSES = [
  'on_time',
  'late',
  'left_early',
  'absent',
  'on_leave',
  'holiday',
  'unscheduled',
  /** the shift hasn't ended and nothing is recorded yet (not absent until it ends) */
  'upcoming',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface AttendanceDay {
  date: string;
  status: AttendanceStatus;
  shift: ScheduledShift | null;
  /** first and last recorded time overlapping the shift (any source: agent or manual) */
  first_start_at: string | null;
  last_end_at: string | null;
  /** recorded time inside the shift */
  worked_seconds: number;
  /** both can be true; `status` shows `late` first */
  late: boolean;
  left_early: boolean;
  late_minutes: number;
  early_minutes: number;
  holiday: string | null;
  leave: { hours: number; partial: boolean } | null;
}

export interface AttendanceSummary {
  scheduled_days: number;
  on_time: number;
  late: number;
  left_early: number;
  absent: number;
  on_leave: number;
  holiday: number;
}

export interface AttendanceResponse {
  user_id: string;
  from: string;
  to: string;
  late_grace_minutes: number;
  early_leave_grace_minutes: number;
  days: AttendanceDay[];
  summary: AttendanceSummary;
}

export interface TeamAttendanceResponse {
  team: { id: string; name: string };
  from: string;
  to: string;
  late_grace_minutes: number;
  early_leave_grace_minutes: number;
  /** sorted by name; there is no ranking */
  members: { user_id: string; display_name: string; days: AttendanceDay[]; summary: AttendanceSummary }[];
}

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  on_time: 'On schedule',
  late: 'Started late',
  left_early: 'Left early',
  absent: 'No time recorded',
  on_leave: 'On leave',
  holiday: 'Holiday',
  unscheduled: 'Not scheduled',
  upcoming: 'Scheduled',
};

/** Statuses drawn with the amber marker (UX §5: never red or green per person). */
export function attendanceNeedsMarker(s: AttendanceStatus): boolean {
  return s === 'late' || s === 'absent' || s === 'left_early';
}

// ───────────────────────── holidays ─────────────────────────

export const holidayCreateRequest = z.strictObject({
  date: calendarDate,
  name: z.string().min(1).max(200),
  /** omit for everyone in the organization */
  team_id: uuid.nullable().optional(),
});

export interface HolidayDTO {
  id: string;
  date: string;
  name: string;
  team_id: string | null;
  team_name: string | null;
}

// ───────────────────────── time off ─────────────────────────

export const TIME_OFF_ACCRUALS = ['none', 'per_month', 'per_year'] as const;
export type TimeOffAccrual = (typeof TIME_OFF_ACCRUALS)[number];
/** Which day of each month (or year) the hours are added (Stage 4 F9). */
export const TIME_OFF_ACCRUAL_DAYS = ['first', 'anniversary', 'last'] as const;
export type TimeOffAccrualDay = (typeof TIME_OFF_ACCRUAL_DAYS)[number];

export const timeOffPolicyCreate = z.strictObject({
  name: z.string().min(1).max(200),
  kind: z.enum(['paid', 'unpaid']),
  accrual: z.enum(TIME_OFF_ACCRUALS).default('none'),
  /** hours added each month or year */
  accrual_hours: hours.default(0),
  accrual_day: z.enum(TIME_OFF_ACCRUAL_DAYS).default('first'),
  max_balance_hours: hours.nullable().optional(),
  /** hours kept into a new calendar year; null/omitted = everything carries over */
  carryover_hours: hours.nullable().optional(),
  allow_negative: z.boolean().default(false),
});
export const timeOffPolicyUpdate = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  accrual: z.enum(TIME_OFF_ACCRUALS).optional(),
  accrual_hours: hours.optional(),
  accrual_day: z.enum(TIME_OFF_ACCRUAL_DAYS).optional(),
  max_balance_hours: hours.nullable().optional(),
  carryover_hours: hours.nullable().optional(),
  allow_negative: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export interface TimeOffPolicyDTO {
  id: string;
  name: string;
  kind: 'paid' | 'unpaid';
  accrual: TimeOffAccrual;
  accrual_hours: number;
  accrual_day: TimeOffAccrualDay;
  max_balance_hours: number | null;
  carryover_hours: number | null;
  allow_negative: boolean;
  archived: boolean;
  assigned_count: number;
}

export const timeOffAssignmentCreate = z.strictObject({
  policy_id: uuid,
  user_id: uuid,
  start_date: calendarDate,
  /** recorded as an adjustment in the ledger */
  opening_balance_hours: z.number().min(-10_000).max(10_000).optional(),
});

export interface TimeOffAssignmentDTO {
  id: string;
  policy_id: string;
  policy_name: string;
  user_id: string;
  user_name: string;
  start_date: string;
  balance_hours: number;
}

export const timeOffAdjustmentCreate = z.strictObject({
  policy_id: uuid,
  user_id: uuid,
  /** positive adds hours, negative removes them */
  hours: z.number().min(-10_000).max(10_000).refine((h) => h !== 0, 'Hours must not be zero'),
  note: z.string().min(3).max(500),
});

export const timeOffRequestCreate = z
  .strictObject({
    policy_id: uuid,
    start_date: calendarDate,
    end_date: calendarDate,
    /** for part of one day; omit for full days */
    partial_hours: z.number().gt(0).max(24).optional(),
    reason: z.string().max(1000).optional(),
  })
  .refine((v) => v.end_date >= v.start_date, { message: 'Ends before it starts', path: ['end_date'] })
  .refine((v) => v.partial_hours === undefined || v.start_date === v.end_date, {
    message: 'Part of a day applies to a single day',
    path: ['partial_hours'],
  });

export type TimeOffStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export interface TimeOffRequestDTO {
  id: string;
  user_id: string;
  user_name: string;
  policy_id: string;
  policy_name: string;
  policy_kind: 'paid' | 'unpaid';
  start_date: string;
  end_date: string;
  partial_hours: number | null;
  hours: number;
  reason: string | null;
  status: TimeOffStatus;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface TimeOffBalanceDTO {
  policy_id: string;
  policy_name: string;
  kind: 'paid' | 'unpaid';
  accrual: TimeOffAccrual;
  accrual_hours: number;
  allow_negative: boolean;
  assigned_from: string;
  balance_hours: number;
  /** hours in pending requests (not yet deducted) */
  pending_hours: number;
}

export interface TimeOffLedgerEntryDTO {
  id: string;
  policy_id: string;
  kind: 'accrual' | 'usage' | 'usage_reversal' | 'adjustment' | 'carryover_expiry';
  hours: number;
  effective_date: string;
  note: string | null;
  request_id: string | null;
  created_at: string;
}

export interface MyTimeOffResponse {
  balances: TimeOffBalanceDTO[];
  requests: TimeOffRequestDTO[];
  ledger: TimeOffLedgerEntryDTO[];
}

/** Body for approve / deny. */
export const timeOffReviewRequest = z.strictObject({ note: z.string().max(1000).optional() });

// ───────────────────────── team calendar ─────────────────────────

export interface TeamCalendarDay {
  date: string;
  /** null when the plan has no schedules or the person isn't scheduled */
  shift: { start_time: string; end_time: string; timezone: string } | null;
  /** approved leave only; the policy and reason are not shown here */
  off: { hours: number; partial: boolean } | null;
  holiday: string | null;
}

export interface TeamCalendarResponse {
  team: { id: string; name: string };
  from: string;
  to: string;
  includes: { schedules: boolean; time_off: boolean };
  members: { user_id: string; display_name: string; days: TeamCalendarDay[] }[];
}
