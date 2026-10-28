import type {
  EffectiveWorkLimits,
  MyWorkLimitsResponse,
  TeamOvertimeReport,
  TimesheetDTO,
  TimesheetStatus,
  TimesheetSummary,
  TimesheetTotals,
  WorkLimitsResponse,
  WorkLimitsUpdate,
} from '@rd/contracts';
import { request, unwrapList } from './api';
import { formatDuration } from './format';

/** Typed client for the timesheet endpoints (kept apart from `rd` in api.ts). */

const enc = encodeURIComponent;

export const timesheetsApi = {
  mine: (from: string, to: string, signal?: AbortSignal) =>
    request<{ items: TimesheetSummary[] }>('GET', '/v1/me/timesheets', { query: { from, to }, signal }).then(unwrapList),
  myWeek: (periodStart: string, signal?: AbortSignal) =>
    request<TimesheetDTO>('GET', `/v1/me/timesheets/${enc(periodStart)}`, { signal }),
  submit: (periodStart: string, note?: string) =>
    request<TimesheetDTO>('POST', `/v1/me/timesheets/${enc(periodStart)}/submit`, { body: note ? { note } : {} }),
  myLimits: (signal?: AbortSignal) => request<MyWorkLimitsResponse>('GET', '/v1/me/work-limits', { signal }),
  memberWeek: (userId: string, periodStart: string, signal?: AbortSignal) =>
    request<TimesheetDTO>('GET', `/v1/users/${enc(userId)}/timesheets/${enc(periodStart)}`, { signal }),
  pending: (signal?: AbortSignal) =>
    request<{ items: TimesheetDTO[] }>('GET', '/v1/timesheets/pending', { signal }).then(unwrapList),
  review: (id: string, verb: 'approve' | 'reject' | 'reopen', note?: string) =>
    request<TimesheetDTO>('POST', `/v1/timesheets/${enc(id)}/${verb}`, { body: note ? { note } : {} }),
  teamOvertime: (teamId: string, from: string, to: string, signal?: AbortSignal) =>
    request<TeamOvertimeReport>('GET', `/v1/teams/${enc(teamId)}/overtime`, { query: { from, to }, signal }),
  workLimits: (signal?: AbortSignal) => request<WorkLimitsResponse>('GET', '/v1/admin/work-limits', { signal }),
  updateWorkLimits: (body: WorkLimitsUpdate) => request<WorkLimitsResponse>('PUT', '/v1/admin/work-limits', { body }),
};

// ───────────────────────── pure helpers ─────────────────────────

export const STATUS_LABEL: Record<TimesheetStatus, string> = {
  draft: 'Not submitted',
  submitted: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Sent back',
  reopened: 'Reopened',
};

/** Badge tone per status — neutral ink only, never red/green. */
export function statusTone(s: TimesheetStatus): 'outline' | 'solid' | 'ink' {
  return s === 'approved' ? 'solid' : 'outline';
}

/** "8h", "7h 30m", "No limit". */
export function formatLimitMinutes(min: number | null): string {
  if (min === null) return 'No limit';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function limitsSummary(l: Pick<EffectiveWorkLimits, 'daily_minutes' | 'weekly_minutes'>): string {
  if (l.daily_minutes === null && l.weekly_minutes === null) return 'No daily or weekly limit';
  const parts: string[] = [];
  if (l.daily_minutes !== null) parts.push(`${formatLimitMinutes(l.daily_minutes)} a day`);
  if (l.weekly_minutes !== null) parts.push(`${formatLimitMinutes(l.weekly_minutes)} a week`);
  return parts.join(' · ');
}

/** "Over limit" cell text: "+1h 30m" or an em dash. */
export function overtimeText(seconds: number): string {
  return seconds > 0 ? `+${formatDuration(seconds)}` : '—';
}

/** "8h" style input value → minutes. Accepts "8", "7.5", "7:30", "7h 30m"; empty = null. */
export function parseLimitInput(raw: string): number | null | 'invalid' {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  let minutes: number;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,3}):([0-5]\d)$/.exec(v))) minutes = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = /^(?:(\d{1,3})\s*h)?\s*(?:(\d{1,4})\s*m)?$/.exec(v)) && (m[1] || m[2])) minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  else if (/^\d{1,3}(\.\d+)?$/.test(v)) minutes = Math.round(Number(v) * 60);
  else return 'invalid';
  return minutes > 0 ? minutes : 'invalid';
}

/** Limit minutes → the editable text shown in an input. */
export function limitInputValue(min: number | null): string {
  return min === null ? '' : formatLimitMinutes(min);
}

export interface GridRow {
  key: string;
  name: string;
  /** seconds per day, Monday first */
  days: number[];
  total: number;
}

/** Project × day matrix for a week's totals (projects by name, "No project" last). */
export function timesheetGrid(t: TimesheetTotals): GridRow[] {
  return t.projects.map((p) => {
    const days = t.days.map((d) => d.projects.find((x) => x.project_id === p.project_id)?.seconds ?? 0);
    return { key: p.project_id ?? 'none', name: p.project_name, days, total: p.seconds };
  });
}

/** The totals that count: frozen at approval, otherwise live. */
export function countedTotals(t: TimesheetDTO): TimesheetTotals {
  return t.status === 'approved' && t.approved_totals ? t.approved_totals : t.totals;
}

/** Which review actions an approver may take now. */
export function reviewActions(t: Pick<TimesheetDTO, 'status' | 'can_review' | 'id'>): ('approve' | 'reject' | 'reopen')[] {
  if (!t.can_review || !t.id) return [];
  if (t.status === 'submitted') return ['approve', 'reject'];
  if (t.status === 'approved') return ['reopen'];
  return [];
}
