import {
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
  type TimeOffAccrualDay,
} from '@rd/contracts';
import { request, unwrapList } from './api';
import { formatDayMonth, formatShortDay, formatTime, weekdayShort } from './time';
import { t } from './i18n';

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
  accrual_day: TimeOffAccrualDay;
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
  if (sorted.length === 7) return t('sched.everyDay');
  if (sorted.length === 0) return '—';
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (contiguous && sorted.length >= 3) return `${weekdayShort(sorted[0]!)}–${weekdayShort(sorted[sorted.length - 1]!)}`;
  return sorted.map((d) => weekdayShort(d)).join(', ');
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
  if (d.status === 'on_leave' && d.leave?.partial) return t('sched.onLeavePartial', { hours: formatHours(d.leave.hours) });
  return t(`sched.att.${d.status}`);
}

/** One-line plain-language detail, e.g. "Started 09:30 · 30 min after the shift start". */
export function attendanceDetail(d: AttendanceDay, tz: string): string {
  const parts: string[] = [];
  if (d.holiday) parts.push(d.holiday);
  if (d.first_start_at && d.last_end_at) parts.push(t('sched.recorded', { from: formatTime(d.first_start_at, tz), to: formatTime(d.last_end_at, tz) }));
  if (d.late) parts.push(t('sched.lateBy', { n: d.late_minutes }));
  if (d.left_early) parts.push(t('sched.earlyBy', { n: d.early_minutes }));
  if (d.status === 'absent') parts.push(t('sched.nothingDuring'));
  if (d.status === 'upcoming') parts.push(t('sched.nothingYet'));
  return parts.join(' · ');
}

/** Short text for a cell in the team "who's off" calendar. */
export function calendarCellLabel(d: TeamCalendarDay): string {
  if (d.holiday) return d.holiday;
  if (d.off) return d.off.partial ? t('sched.offPartial', { hours: formatHours(d.off.hours) }) : t('sched.off');
  if (d.shift) return shiftTimesLabel(d.shift);
  return '—';
}

export const requestStatusLabel = (s: TimeOffRequestDTO['status']): string => t(`sched.req.${s}`);

export const ledgerKindLabel = (k: MyTimeOffResponse['ledger'][number]['kind']): string => t(`sched.ledger.${k}`);

/** When the hours are added, for the policy form's choices and its summary (Stage 4 F9). */
export function accrualDayLabel(accrual: TimeOffAccrual, day: TimeOffAccrualDay): string {
  if (accrual === 'per_year') return day === 'first' ? t('sched.accrual.yearFirst') : day === 'last' ? t('sched.accrual.yearLast') : t('sched.accrual.yearStart');
  return day === 'first' ? t('sched.accrual.monthFirst') : day === 'last' ? t('sched.accrual.monthLast') : t('sched.accrual.monthStart');
}

export function accrualLabel(p: { accrual: TimeOffAccrual; accrual_hours: number; accrual_day?: TimeOffAccrualDay }): string {
  if (p.accrual === 'none') return t('sched.noAccrual');
  return t(p.accrual === 'per_month' ? 'sched.perMonth' : 'sched.perYear', { hours: formatHours(p.accrual_hours), day: accrualDayLabel(p.accrual, p.accrual_day ?? 'first') });
}

/** Signed hours: "+8 h", "−24 h". */
export function signedHours(h: number): string {
  return `${h > 0 ? '+' : h < 0 ? '−' : ''}${formatHours(Math.abs(h))}`;
}

export function weekLabel(start: string, end: string): string {
  return `${formatDayMonth(start)} – ${formatDayMonth(end)}`;
}

export { formatHours };
