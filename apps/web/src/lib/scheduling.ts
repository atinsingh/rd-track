import {
  ATTENDANCE_LABELS,
  formatHours,
  type AttendanceDay,
  type AttendanceResponse,
  type HolidayDTO,
  type MyScheduleResponse,
  type MyTimeOffResponse,
  type SchedulingSettingsDTO,
  type ShiftDTO,
  type ShiftOverrideDTO,
  type TeamAttendanceResponse,
  type TeamCalendarDay,
  type TeamCalendarResponse,
  type TimeOffAssignmentDTO,
  type TimeOffPolicyDTO,
  type TimeOffRequestDTO,
  type TimeOffAccrual,
} from '@rd/contracts';
import { request, unwrapList } from './api';
import { formatDayMonth, formatShortDay, formatTime, WEEKDAY_SHORT } from './time';

/**
 * Client and display helpers for schedules, attendance and time off (Stage 3).
 * Dates are calendar days `YYYY-MM-DD`; ranges are inclusive.
 */

const enc = encodeURIComponent;
type List<T> = T[] | { items: T[] };
const get = <T>(path: string, query?: Record<string, string | undefined>, signal?: AbortSignal) => request<T>('GET', path, { query, signal });
const list = async <T>(path: string, query?: Record<string, string | undefined>, signal?: AbortSignal) => unwrapList(await get<List<T>>(path, query, signal));
const send = <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
  request<T>(method, path, method === 'DELETE' ? {} : { body: body ?? {} });

export interface DateRange {
  from: string;
  to: string;
}

export interface ShiftBody {
  user_id: string;
  timezone?: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to?: string | null;
}
export interface PolicyBody {
  name: string;
  kind: 'paid' | 'unpaid';
  accrual: TimeOffAccrual;
  accrual_hours: number;
  max_balance_hours: number | null;
  carryover_hours: number | null;
  allow_negative: boolean;
}

export const sched = {
  my: {
    schedule: (r: DateRange, signal?: AbortSignal) => get<MyScheduleResponse>('/v1/me/schedule', { ...r }, signal),
    attendance: (r: DateRange, signal?: AbortSignal) => get<AttendanceResponse>('/v1/me/attendance', { ...r }, signal),
    timeOff: (signal?: AbortSignal) => get<MyTimeOffResponse>('/v1/me/time-off', undefined, signal),
    estimate: (q: { start_date: string; end_date: string; partial_hours?: number }, signal?: AbortSignal) =>
      get<{ hours: number }>(
        '/v1/me/time-off/estimate',
        { start_date: q.start_date, end_date: q.end_date, partial_hours: q.partial_hours?.toString() },
        signal,
      ),
    request: (body: { policy_id: string; start_date: string; end_date: string; partial_hours?: number; reason?: string }) =>
      send<TimeOffRequestDTO>('POST', '/v1/me/time-off/requests', body),
    cancel: (id: string) => send<TimeOffRequestDTO>('POST', `/v1/me/time-off/requests/${enc(id)}/cancel`),
  },
  review: {
    pending: (signal?: AbortSignal) => list<TimeOffRequestDTO>('/v1/time-off/pending', undefined, signal),
    approve: (id: string, note?: string) => send<TimeOffRequestDTO>('POST', `/v1/time-off/requests/${enc(id)}/approve`, note ? { note } : {}),
    deny: (id: string, note?: string) => send<TimeOffRequestDTO>('POST', `/v1/time-off/requests/${enc(id)}/deny`, note ? { note } : {}),
  },
  team: {
    attendance: (teamId: string, r: DateRange, signal?: AbortSignal) =>
      get<TeamAttendanceResponse>(`/v1/teams/${enc(teamId)}/attendance`, { ...r }, signal),
    calendar: (teamId: string, r: DateRange, signal?: AbortSignal) =>
      get<TeamCalendarResponse>(`/v1/teams/${enc(teamId)}/calendar`, { ...r }, signal),
  },
  admin: {
    settings: (signal?: AbortSignal) => get<SchedulingSettingsDTO>('/v1/admin/scheduling/settings', undefined, signal),
    updateSettings: (body: Partial<SchedulingSettingsDTO>) => send<SchedulingSettingsDTO>('PUT', '/v1/admin/scheduling/settings', body),
    shifts: (signal?: AbortSignal) => list<ShiftDTO>('/v1/admin/shifts', undefined, signal),
    createShift: (body: ShiftBody) => send<ShiftDTO>('POST', '/v1/admin/shifts', body),
    removeShift: (id: string) => send<{ ended: boolean }>('DELETE', `/v1/admin/shifts/${enc(id)}`),
    overrides: (r: DateRange, signal?: AbortSignal) => list<ShiftOverrideDTO>('/v1/admin/shift-overrides', { ...r }, signal),
    setOverride: (body: { user_id: string; date: string; kind: 'change' | 'cancel'; start_time?: string; end_time?: string; note?: string }) =>
      send<ShiftOverrideDTO>('POST', '/v1/admin/shift-overrides', body),
    removeOverride: (id: string) => send<{ ok: true }>('DELETE', `/v1/admin/shift-overrides/${enc(id)}`),
    holidays: (year: string, signal?: AbortSignal) => list<HolidayDTO>('/v1/admin/holidays', { year }, signal),
    createHoliday: (body: { date: string; name: string; team_id?: string | null }) => send<HolidayDTO>('POST', '/v1/admin/holidays', body),
    removeHoliday: (id: string) => send<{ ok: true }>('DELETE', `/v1/admin/holidays/${enc(id)}`),
    policies: (signal?: AbortSignal) => list<TimeOffPolicyDTO>('/v1/admin/time-off/policies', undefined, signal),
    createPolicy: (body: PolicyBody) => send<TimeOffPolicyDTO>('POST', '/v1/admin/time-off/policies', body),
    updatePolicy: (id: string, body: Partial<PolicyBody> & { archived?: boolean }) =>
      send<TimeOffPolicyDTO>('PATCH', `/v1/admin/time-off/policies/${enc(id)}`, body),
    assignments: (signal?: AbortSignal) => list<TimeOffAssignmentDTO>('/v1/admin/time-off/assignments', undefined, signal),
    assign: (body: { policy_id: string; user_id: string; start_date: string; opening_balance_hours?: number }) =>
      send<TimeOffAssignmentDTO>('POST', '/v1/admin/time-off/assignments', body),
    unassign: (id: string) => send<{ ok: true }>('DELETE', `/v1/admin/time-off/assignments/${enc(id)}`),
    adjust: (body: { policy_id: string; user_id: string; hours: number; note: string }) =>
      send<TimeOffAssignmentDTO>('POST', '/v1/admin/time-off/adjustments', body),
  },
};

// ───────────── display helpers ─────────────

/** "Mon–Fri", "Mon, Wed, Fri", "Every day" */
export function weekdaysLabel(days: readonly number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 7) return 'Every day';
  if (sorted.length === 0) return '—';
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (contiguous && sorted.length >= 3) return `${WEEKDAY_SHORT[sorted[0]! - 1]}–${WEEKDAY_SHORT[sorted[sorted.length - 1]! - 1]}`;
  return sorted.map((d) => WEEKDAY_SHORT[d - 1]).join(', ');
}

/** "09:00–17:00" or "22:00–06:00 (+1)" for overnight shifts. */
export function shiftTimesLabel(s: { start_time: string; end_time: string }): string {
  const overnight = s.end_time <= s.start_time;
  return `${s.start_time}–${s.end_time}${overnight ? ' (+1)' : ''}`;
}

export function dateSpanLabel(start: string, end: string): string {
  return start === end ? formatShortDay(start) : `${formatShortDay(start)} – ${formatShortDay(end)}`;
}

export function attendanceLabel(d: AttendanceDay): string {
  if (d.status === 'on_leave' && d.leave?.partial) return `On leave · ${formatHours(d.leave.hours)}`;
  return ATTENDANCE_LABELS[d.status];
}

/** One-line plain-language detail, e.g. "Started 09:30 · 30 min after the shift start". */
export function attendanceDetail(d: AttendanceDay, tz: string): string {
  const parts: string[] = [];
  if (d.holiday) parts.push(d.holiday);
  if (d.first_start_at && d.last_end_at) parts.push(`Recorded ${formatTime(d.first_start_at, tz)}–${formatTime(d.last_end_at, tz)}`);
  if (d.late) parts.push(`started ${d.late_minutes} min after the shift start`);
  if (d.left_early) parts.push(`ended ${d.early_minutes} min before the shift end`);
  if (d.status === 'absent') parts.push('nothing recorded during the shift');
  if (d.status === 'upcoming') parts.push('nothing recorded yet');
  return parts.join(' · ');
}

/** Short text for a cell in the team "who's off" calendar. */
export function calendarCellLabel(d: TeamCalendarDay): string {
  if (d.holiday) return d.holiday;
  if (d.off) return d.off.partial ? `Off ${formatHours(d.off.hours)}` : 'Off';
  if (d.shift) return shiftTimesLabel(d.shift);
  return '—';
}

export const REQUEST_STATUS_LABEL: Record<TimeOffRequestDTO['status'], string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Not approved',
  cancelled: 'Cancelled',
};

export const LEDGER_KIND_LABEL: Record<MyTimeOffResponse['ledger'][number]['kind'], string> = {
  accrual: 'Accrued',
  usage: 'Taken',
  usage_reversal: 'Returned (cancelled)',
  adjustment: 'Adjustment',
  carryover_expiry: 'Above carryover (expired)',
};

export function accrualLabel(p: { accrual: TimeOffAccrual; accrual_hours: number }): string {
  if (p.accrual === 'none') return 'No accrual';
  return `${formatHours(p.accrual_hours)} per ${p.accrual === 'per_month' ? 'month' : 'year'}`;
}

/** Signed hours: "+8 h", "−24 h". */
export function signedHours(h: number): string {
  return `${h > 0 ? '+' : h < 0 ? '−' : ''}${formatHours(Math.abs(h))}`;
}

export function weekLabel(start: string, end: string): string {
  return `${formatDayMonth(start)} – ${formatDayMonth(end)}`;
}

export { formatHours };
