import { shiftHours, type ExpectedDay, type ExpectedHours, type ExpectedSource } from '@rd/contracts';
import { resolveShift, shiftActiveOn, type PersonCalendar } from '../scheduling/attendance';
import { isoWeekday } from '../scheduling/tz';

/**
 * Expected hours (Stage 4 F6), worked out on read like attendance: the person's schedule,
 * else their work limits, else the organization's standard day on weekdays. Holidays
 * expect nothing; approved time off is taken off.
 */

export interface DayLimits {
  daily_minutes: number | null;
  weekly_minutes: number | null;
}

const HOUR = 3600;

export function expectedOn(
  cal: Pick<PersonCalendar, 'shifts' | 'overrides' | 'holidays' | 'leave'>,
  date: string,
  limits: DayLimits,
  defaultDayHours: number,
): Omit<ExpectedDay, 'tracked_seconds' | 'focus_seconds'> {
  const weekday = isoWeekday(date) <= 5;
  let hours: number;
  let source: ExpectedSource;
  const { shift, cancelled } = resolveShift(cal, date);
  if (shift || cancelled || cal.shifts.some((s) => shiftActiveOn(s, date))) {
    // Someone with a schedule is expected on their shifts only.
    source = 'schedule';
    hours = shift ? shiftHours(shift.start_time, shift.end_time) : 0;
  } else if (limits.daily_minutes !== null || limits.weekly_minutes !== null) {
    source = 'work_limits';
    hours = weekday ? (limits.daily_minutes ?? limits.weekly_minutes! / 5) / 60 : 0;
  } else {
    source = 'default';
    hours = weekday ? defaultDayHours : 0;
  }
  const holiday = cal.holidays.get(date) ?? null;
  if (holiday) hours = 0;
  const leave = cal.leave.find((l) => l.start_date <= date && date <= l.end_date);
  const leaveHours = leave ? Math.min(hours, leave.partial_hours ?? hours) : 0;
  return {
    date,
    expected_seconds: Math.round((hours - leaveHours) * HOUR),
    source,
    holiday,
    leave_seconds: Math.round(leaveHours * HOUR),
  };
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Mon–Fri", "Mon, Wed, Fri", "Tue–Thu, Sat". */
export function weekdayRanges(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const a = DAY_NAMES[sorted[i]! - 1]!;
    const b = DAY_NAMES[sorted[j]! - 1]!;
    parts.push(j - i >= 2 ? `${a}–${b}` : j > i ? `${a}, ${b}` : a);
    i = j + 1;
  }
  return parts.join(', ');
}

/** Totals over the days, with the source used most often and a plain description of it. */
export function summarizeExpected(
  days: ExpectedDay[],
  cal: Pick<PersonCalendar, 'shifts'>,
  limits: DayLimits,
  defaultDayHours: number,
): ExpectedHours {
  const expected = days.reduce((n, d) => n + d.expected_seconds, 0);
  const tracked = days.reduce((n, d) => n + d.tracked_seconds, 0);
  const counts = new Map<ExpectedSource, number>();
  for (const d of days) counts.set(d.source, (counts.get(d.source) ?? 0) + 1);
  const source = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'default';
  const shift = cal.shifts[0];
  return {
    expected_seconds: expected,
    tracked_seconds: tracked,
    percent: expected > 0 ? Math.round((tracked / expected) * 100) : null,
    source,
    schedule: source === 'schedule' && shift ? `${weekdayRanges(shift.weekdays)} ${shift.start_time}–${shift.end_time}` : null,
    day_hours:
      source === 'work_limits'
        ? (limits.daily_minutes ?? (limits.weekly_minutes ?? 0) / 5) / 60
        : source === 'default'
          ? defaultDayHours
          : null,
    days,
  };
}
