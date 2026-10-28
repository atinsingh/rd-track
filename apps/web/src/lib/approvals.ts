import type { ApprovalType, CorrectionDTO, TimeOffRequestDTO, TimesheetDTO } from '@rd/contracts';
import { formatDuration } from './format';
import { dateSpanLabel, formatHours } from './scheduling';
import { addDays, dateInTz, formatDayMonth, formatShortDay, formatTime } from './time';

/** One row of the approvals inbox (Stage 4 F2), whatever kind of request it is. */
export interface InboxItem {
  type: ApprovalType;
  id: string;
  /** Tab it belongs to. */
  group: 'timesheets' | 'time' | 'timeoff';
  who: string;
  what: string;
  kindLabel: string;
  amount: string;
  submittedAt: string;
  /** Something the reviewer should notice before approving. */
  flag: string | null;
}

export const INBOX_TABS = [
  { key: 'all', label: 'All' },
  { key: 'timesheets', label: 'Timesheets' },
  { key: 'time', label: 'Time and corrections' },
  { key: 'timeoff', label: 'Time off' },
] as const;
export type InboxTab = (typeof INBOX_TABS)[number]['key'];

const KIND_LABEL: Record<CorrectionDTO['kind'], string> = { edit: 'Correction', manual_add: 'Manual time', idle_reassign: 'Idle time moved' };

function correctionItem(c: CorrectionDTO, tz: string): InboxItem {
  const v = c.requested;
  const s = Date.parse(v.started_at);
  const e = Date.parse(v.ended_at);
  const when = `${formatShortDay(dateInTz(s, tz))} ${formatTime(s, tz)}–${formatTime(e, tz)}`;
  const target = v.project_id ? (c.project_names?.[v.project_id] ?? 'a project') : 'no project';
  const what =
    c.kind === 'manual_add' ? `Add ${when} · ${target}` : c.kind === 'idle_reassign' ? `Away ${when} → ${target}` : `Change to ${when} · ${target}`;
  return {
    type: 'correction', id: c.id, group: 'time', who: c.user_name, what, kindLabel: KIND_LABEL[c.kind],
    amount: formatDuration((e - s) / 1000), submittedAt: c.created_at, flag: null,
  };
}

function timesheetItem(t: TimesheetDTO): InboxItem {
  const totals = t.submitted_totals ?? t.totals;
  return {
    type: 'timesheet', id: t.id!, group: 'timesheets', who: t.user_name,
    what: `Week of ${formatDayMonth(t.period_start)} – ${formatDayMonth(addDays(t.period_start, 6))}`,
    kindLabel: 'Timesheet', amount: formatDuration(totals.total_seconds), submittedAt: t.submitted_at ?? '',
    flag: t.changed_since_submit ? 'Changed after submitting' : null,
  };
}

function timeOffItem(r: TimeOffRequestDTO): InboxItem {
  return {
    type: 'time_off', id: r.id, group: 'timeoff', who: r.user_name,
    what: `${r.policy_name} · ${dateSpanLabel(r.start_date, r.end_date)}${r.partial_hours !== null ? ' (part of a day)' : ''}`,
    kindLabel: 'Time off', amount: formatHours(r.hours), submittedAt: r.created_at, flag: null,
  };
}

/** Every pending request in one list, oldest first. */
export function inboxItems(
  corrections: readonly CorrectionDTO[],
  timesheets: readonly TimesheetDTO[],
  timeOff: readonly TimeOffRequestDTO[],
  tz: string,
): InboxItem[] {
  return [...timesheets.filter((t) => t.id).map(timesheetItem), ...corrections.map((c) => correctionItem(c, tz)), ...timeOff.map(timeOffItem)].sort(
    (a, b) => a.submittedAt.localeCompare(b.submittedAt),
  );
}

export function inTab(items: readonly InboxItem[], tab: InboxTab): InboxItem[] {
  return tab === 'all' ? [...items] : items.filter((i) => i.group === tab);
}

export const itemKey = (i: Pick<InboxItem, 'type' | 'id'>) => `${i.type}:${i.id}`;

/** "3 approved · 1 couldn't be: already reviewed" from a batch response. */
export function batchSummary(
  r: { approved: number; rejected: number; failed: number; results: { ok: boolean; message?: string }[] },
): string {
  const done = r.approved ? `${r.approved} approved` : `${r.rejected} sent back`;
  if (!r.failed) return done;
  const reasons = [...new Set(r.results.filter((x) => !x.ok).map((x) => (x.message ?? 'not allowed').replace(/\.$/, '').toLowerCase()))];
  return `${done} · ${r.failed} couldn't be: ${reasons.join('; ')}`;
}
