import { describe, expect, it } from 'vitest';
import type { CorrectionDTO, DeletionRequestDTO, TimeOffRequestDTO, TimesheetDTO } from '@rd/contracts';
import { batchSummary, inTab, inboxItems } from './approvals';

const correction = (over: Partial<CorrectionDTO>): CorrectionDTO =>
  ({
    id: 'c1', user_id: 'u1', user_name: 'Tom Becker', session_id: null, kind: 'manual_add', original: null,
    requested: { started_at: '2026-10-26T08:00:00Z', ended_at: '2026-10-26T08:45:00Z', project_id: 'p1' },
    reason: 'Forgot', status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null,
    created_at: '2026-10-27T09:00:00Z', project_names: { p1: 'Client A' }, ...over,
  }) as CorrectionDTO;
const sheet = { id: 't1', user_name: 'Jun Park', period_start: '2026-10-26', submitted_at: '2026-10-26T12:00:00Z', changed_since_submit: true,
  submitted_totals: { total_seconds: 122520 }, totals: { total_seconds: 125000 } } as unknown as TimesheetDTO;
const leave = { id: 'o1', user_name: 'Dana Whitfield', policy_name: 'Annual leave', start_date: '2026-10-30', end_date: '2026-10-30',
  partial_hours: null, hours: 8, created_at: '2026-10-28T09:00:00Z' } as unknown as TimeOffRequestDTO;

describe('approvals inbox', () => {
  const items = inboxItems(
    [correction({}), correction({ id: 'c2', kind: 'idle_reassign', created_at: '2026-10-28T10:00:00Z', requested: { started_at: '2026-10-27T13:00:00Z', ended_at: '2026-10-27T13:25:00Z', project_id: 'p2' }, project_names: { p2: 'Internal' } })],
    [sheet],
    [leave],
    'UTC',
  );
  it('merges every kind of request, oldest first, with what a reviewer needs to see', () => {
    expect(items.map((i) => [i.type, i.who, i.kindLabel, i.what, i.amount, i.flag])).toEqual([
      ['timesheet', 'Jun Park', 'Timesheet', 'Week of 26 Oct – 1 Nov', '34h 02m', 'Changed after submitting'],
      ['correction', 'Tom Becker', 'Manual time', 'Add Mon 26 Oct 08:00–08:45 · Client A', '0h 45m', null],
      ['time_off', 'Dana Whitfield', 'Time off', 'Annual leave · Fri 30 Oct', '8 h', null],
      ['correction', 'Tom Becker', 'Idle time moved', 'Away Tue 27 Oct 13:00–13:25 → Internal', '0h 25m', null],
    ]);
  });
  it('filters by tab', () => {
    expect(inTab(items, 'time').map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(inTab(items, 'timeoff').map((i) => i.id)).toEqual(['o1']);
    expect(inTab(items, 'all')).toHaveLength(4);
  });
  it('adds pending deletion requests under their own tab, never decided ones', () => {
    const del = (over: Partial<DeletionRequestDTO>): DeletionRequestDTO => ({
      id: 'd1', requester_id: 'u3', requester_name: 'Sam Rivera', target_type: 'screenshot', target_id: 's1', reason: 'Personal tab open',
      status: 'pending', reviewer_id: null, created_at: '2026-10-25T08:00:00Z', completed_at: null, ...over,
    });
    const withDeletions = inboxItems([], [sheet], [], 'UTC', [del({}), del({ id: 'd2', status: 'approved' })]);
    expect(withDeletions.map((i) => [i.type, i.who, i.kindLabel, i.amount])).toEqual([
      ['deletion_request', 'Sam Rivera', 'Deletion request', '1 screenshot'],
      ['timesheet', 'Jun Park', 'Timesheet', '34h 02m'],
    ]);
    expect(inTab(withDeletions, 'privacy').map((i) => i.id)).toEqual(['d1']);
  });
  it('summarises a batch result, naming why items failed', () => {
    expect(batchSummary({ approved: 3, rejected: 0, failed: 0, results: [] })).toBe('3 approved');
    expect(
      batchSummary({ approved: 2, rejected: 0, failed: 1, results: [{ ok: true }, { ok: true }, { ok: false, message: 'This correction has already been reviewed.' }] }),
    ).toBe("2 approved · 1 couldn't be: this correction has already been reviewed");
    expect(batchSummary({ approved: 0, rejected: 2, failed: 0, results: [] })).toBe('2 sent back');
  });
});
