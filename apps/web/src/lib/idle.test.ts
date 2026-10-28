import { describe, expect, it } from 'vitest';
import type { IdleAdjustmentDTO, SessionDTO } from '@rd/contracts';
import { idleNotes } from './idle';

const base: SessionDTO = {
  id: 's', user_id: 'u', device_id: 'd', project_id: 'p', project_name: 'Client A', task_id: null, task_name: null,
  state: 'stopped', source: 'agent', corrected: false, started_at: '2026-10-26T09:00:00Z', ended_at: '2026-10-26T12:00:00Z',
  tracked_seconds: 9000, active_seconds: 8000, idle_seconds: 1000, paused_seconds: 0, idle_adjustments: [],
};
const adj = (over: Partial<IdleAdjustmentDTO>): IdleAdjustmentDTO => ({
  id: 'a', idle_started_at: '2026-10-26T10:12:00Z', idle_ended_at: '2026-10-26T10:30:00Z', seconds: 1080,
  decision: 'discard', status: 'applied', status_reason: null, project_name: null, ...over,
});
const notes = (a: Partial<IdleAdjustmentDTO>) => idleNotes({ ...base, idle_adjustments: [adj(a)] }, 'UTC');

describe('idle notes on a session', () => {
  it('describes removed and moved time in neutral words', () => {
    expect(notes({})).toEqual(['18 min away (10:12–10:30) removed on return']);
    expect(notes({ decision: 'reassign', status: 'pending', project_name: 'Internal' })).toEqual(['18 min away (10:12–10:30) → Internal · waiting for approval']);
    expect(notes({ decision: 'reassign', status: 'applied', project_name: 'Internal' })).toEqual(['18 min away (10:12–10:30) moved to Internal']);
    expect(notes({ decision: 'reassign', status: 'rejected', project_name: 'Internal' })).toEqual(['18 min away (10:12–10:30) — move to Internal not approved, kept here']);
    expect(notes({ status: 'rejected', status_reason: 'week_locked' })).toEqual([
      "18 min away (10:12–10:30) — couldn't be removed: that week is approved and locked",
    ]);
  });
  it('lists nothing when nothing was changed', () => {
    expect(idleNotes(base, 'UTC')).toEqual([]);
  });
});
