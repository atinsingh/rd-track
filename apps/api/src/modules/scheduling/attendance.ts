import {
  isOvernight,
  shiftHours,
  type AttendanceDay,
  type AttendanceSummary,
  type ScheduleDay,
  type ScheduledShift,
} from '@rd/contracts';
import { addDays, isoWeekday, zonedTimeToMs } from './tz';

/**
 * Pure attendance and schedule rules. Attendance is computed on read (never stored) from
 * the person's shifts, overrides, holidays, approved leave and recorded sessions.
 */

export interface ShiftRow {
  id: string;
  timezone: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
}
export interface OverrideRow {
  date: string;
  kind: 'change' | 'cancel';
  timezone: string;
  start_time: string | null;
  end_time: string | null;
}
export interface LeaveRow {
  start_date: string;
  end_date: string;
  partial_hours: number | null;
}
export interface SessionSpan {
  started_at: string;
  ended_at: string | null;
}
export interface Settings {
  late_grace_minutes: number;
  early_leave_grace_minutes: number;
  default_day_hours: number;
}

/** Everything needed to work out one person's schedule and attendance. */
export interface PersonCalendar {
  shifts: ShiftRow[];
  overrides: Map<string, OverrideRow>;
  /** date → holiday name (organization-wide or for one of the person's teams) */
  holidays: Map<string, string>;
  leave: LeaveRow[];
  sessions: SessionSpan[];
}

const MIN = 60_000;

function instance(date: string, tz: string, start: string, end: string, source: ScheduledShift['source'], shiftId: string | null): ScheduledShift {
  const overnight = isOvernight(start, end);
  return {
    date,
    timezone: tz,
    start_time: start,
    end_time: end,
    start_at: new Date(zonedTimeToMs(date, start, tz)).toISOString(),
    end_at: new Date(zonedTimeToMs(overnight ? addDays(date, 1) : date, end, tz)).toISOString(),
    overnight,
    source,
    shift_id: shiftId,
  };
}

export function shiftActiveOn(s: ShiftRow, date: string): boolean {
  return s.effective_from <= date && (s.effective_to === null || date <= s.effective_to);
}

/** The shift that starts on `date` (an overnight shift belongs to the day it starts). */
export function resolveShift(cal: Pick<PersonCalendar, 'shifts' | 'overrides'>, date: string): { shift: ScheduledShift | null; cancelled: boolean } {
  const o = cal.overrides.get(date);
  if (o?.kind === 'cancel') return { shift: null, cancelled: true };
  if (o?.kind === 'change') return { shift: instance(date, o.timezone, o.start_time!, o.end_time!, 'override', null), cancelled: false };
  const wd = isoWeekday(date);
  const s = cal.shifts.find((x) => shiftActiveOn(x, date) && x.weekdays.includes(wd));
  return { shift: s ? instance(date, s.timezone, s.start_time, s.end_time, 'shift', s.id) : null, cancelled: false };
}

export function scheduleDay(cal: PersonCalendar, date: string): ScheduleDay {
  const { shift, cancelled } = resolveShift(cal, date);
  return { date, shift, cancelled, holiday: cal.holidays.get(date) ?? null };
}

/**
 * Hours one day of leave costs: nothing on holidays; the shift's nominal length on a
 * scheduled day; nothing on an unscheduled day for someone with a schedule; otherwise
 * the default day on weekdays (Mon–Fri) only.
 */
export function leaveHoursOn(cal: Pick<PersonCalendar, 'shifts' | 'overrides' | 'holidays'>, date: string, s: Settings): number {
  if (cal.holidays.has(date)) return 0;
  const { shift, cancelled } = resolveShift(cal, date);
  if (shift) return shiftHours(shift.start_time, shift.end_time);
  if (cancelled || cal.shifts.some((x) => shiftActiveOn(x, date))) return 0;
  return isoWeekday(date) <= 5 ? s.default_day_hours : 0;
}

export function leaveOn(cal: PersonCalendar, date: string, s: Settings): AttendanceDay['leave'] {
  const l = cal.leave.find((x) => x.start_date <= date && date <= x.end_date);
  if (!l) return null;
  if (l.partial_hours !== null) return { hours: l.partial_hours, partial: true };
  return { hours: leaveHoursOn(cal, date, s), partial: false };
}

export function attendanceDay(cal: PersonCalendar, date: string, s: Settings, nowMs: number): AttendanceDay {
  const { shift } = resolveShift(cal, date);
  const holiday = cal.holidays.get(date) ?? null;
  const leave = leaveOn(cal, date, s);
  const day: AttendanceDay = {
    date,
    status: 'unscheduled',
    shift,
    first_start_at: null,
    last_end_at: null,
    worked_seconds: 0,
    late: false,
    left_early: false,
    late_minutes: 0,
    early_minutes: 0,
    holiday,
    leave,
  };

  if (shift) {
    const start = Date.parse(shift.start_at);
    const end = Date.parse(shift.end_at);
    let first = Infinity;
    let last = -Infinity;
    let open = false;
    let worked = 0;
    for (const x of cal.sessions) {
      const a = Date.parse(x.started_at);
      const b = x.ended_at ? Date.parse(x.ended_at) : nowMs;
      if (a >= end || b <= start) continue;
      first = Math.min(first, a);
      last = Math.max(last, b);
      open ||= x.ended_at === null;
      worked += Math.min(b, end) - Math.max(a, start);
    }
    if (Number.isFinite(first)) {
      day.first_start_at = new Date(first).toISOString();
      day.last_end_at = new Date(last).toISOString();
      day.worked_seconds = Math.round(worked / 1000);
      if (first > start + s.late_grace_minutes * MIN) {
        day.late = true;
        day.late_minutes = Math.round((first - start) / MIN);
      }
      if (!open && nowMs >= end && last < end - s.early_leave_grace_minutes * MIN) {
        day.left_early = true;
        day.early_minutes = Math.round((end - last) / MIN);
      }
    }
    if (holiday) day.status = 'holiday';
    else if (leave) day.status = 'on_leave';
    else if (!Number.isFinite(first)) day.status = nowMs >= end ? 'absent' : 'upcoming';
    else day.status = day.late ? 'late' : day.left_early ? 'left_early' : 'on_time';
    if (holiday || leave) {
      // Leave and holidays excuse the schedule: no lateness is reported on those days.
      day.late = day.left_early = false;
      day.late_minutes = day.early_minutes = 0;
    }
  } else if (holiday) {
    day.status = 'holiday';
  } else if (leave && leave.hours > 0) {
    day.status = 'on_leave';
  }
  return day;
}

export function summarize(days: AttendanceDay[]): AttendanceSummary {
  const sum: AttendanceSummary = { scheduled_days: 0, on_time: 0, late: 0, left_early: 0, absent: 0, on_leave: 0, holiday: 0 };
  for (const d of days) {
    if (d.shift) sum.scheduled_days++;
    if (d.status === 'on_time') sum.on_time++;
    else if (d.status === 'late') sum.late++;
    else if (d.status === 'absent') sum.absent++;
    else if (d.status === 'on_leave') sum.on_leave++;
    else if (d.status === 'holiday') sum.holiday++;
    if (d.left_early) sum.left_early++;
  }
  return sum;
}
