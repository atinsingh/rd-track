import { describe, expect, it } from 'vitest';
import type { AttendanceDay, Me } from '@rd/contracts';
import { accessFor, navFor } from './nav';
import { attendanceDetail, attendanceLabel, calendarCellLabel, shiftTimesLabel, signedHours, weekdaysLabel } from './scheduling';

const day = (over: Partial<AttendanceDay>): AttendanceDay => ({
  date: '2026-10-20',
  status: 'on_time',
  shift: null,
  first_start_at: null,
  last_end_at: null,
  worked_seconds: 0,
  late: false,
  left_early: false,
  late_minutes: 0,
  early_minutes: 0,
  holiday: null,
  leave: null,
  ...over,
});

describe('schedule labels', () => {
  it('summarises weekdays', () => {
    expect(weekdaysLabel([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(weekdaysLabel([5, 1, 3])).toBe('Mon, Wed, Fri');
    expect(weekdaysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(weekdaysLabel([6, 7])).toBe('Sat, Sun');
  });
  it('marks overnight shifts', () => {
    expect(shiftTimesLabel({ start_time: '09:00', end_time: '17:00' })).toBe('09:00–17:00');
    expect(shiftTimesLabel({ start_time: '22:00', end_time: '06:00' })).toBe('22:00–06:00 (+1)');
  });
  it('describes attendance in schedule terms', () => {
    const late = day({
      status: 'late',
      late: true,
      late_minutes: 30,
      first_start_at: '2026-10-20T13:30:00Z',
      last_end_at: '2026-10-20T21:00:00Z',
    });
    expect(attendanceLabel(late)).toBe('Started late');
    expect(attendanceDetail(late, 'America/Toronto')).toBe('Recorded 09:30–17:00 · started 30 min after the shift start');
    expect(attendanceLabel(day({ status: 'on_leave', leave: { hours: 4, partial: true } }))).toBe('On leave · 4 h');
    expect(attendanceDetail(day({ status: 'absent' }), 'UTC')).toBe('nothing recorded during the shift');
  });
  it('labels calendar cells without leave details', () => {
    expect(calendarCellLabel({ date: 'd', shift: null, off: { hours: 8, partial: false }, holiday: null })).toBe('Off');
    expect(calendarCellLabel({ date: 'd', shift: null, off: { hours: 3, partial: true }, holiday: null })).toBe('Off 3 h');
    expect(calendarCellLabel({ date: 'd', shift: { start_time: '09:00', end_time: '17:00', timezone: 'UTC' }, off: null, holiday: null })).toBe('09:00–17:00');
    expect(calendarCellLabel({ date: 'd', shift: null, off: null, holiday: 'Founders Day' })).toBe('Founders Day');
  });
  it('signs hours', () => {
    expect(signedHours(8)).toBe('+8 h');
    expect(signedHours(-24)).toBe('−24 h');
  });
});

describe('scheduling navigation', () => {
  const me = (role: Me['user']['org_role'], entitlements: Me['entitlements'], teams: string[] = []): Me => ({
    user: { id: 'u', email: 'e', display_name: 'D', org_role: role, timezone: 'UTC', tracking_enabled: true, mfa_enabled: false },
    organization: { id: 'o', name: 'Org', plan: 'pro', license: 'active' },
    mfa_verified: true,
    managed_team_ids: teams,
    managed_project_ids: [],
    entitlements,
  });
  const hrefs = (m: Me) => navFor(accessFor(m)).flatMap((g) => g.items.map((i) => i.href));

  it('follows the plan: Pro gets schedules, Standard gets time off only', () => {
    expect(hrefs(me('employee', ['schedules', 'time_off']))).toContain('/me/schedule');
    expect(hrefs(me('employee', []))).not.toContain('/me/schedule');
    const stdAdmin = hrefs(me('org_admin', ['time_off']));
    expect(stdAdmin).toEqual(expect.arrayContaining(['/admin/holidays', '/admin/time-off', '/approvals']));
    expect(stdAdmin).not.toContain('/admin/schedules');
    expect(hrefs(me('org_admin', ['schedules', 'time_off']))).toContain('/admin/schedules');
  });
  it('shows team attendance to managers only', () => {
    expect(hrefs(me('employee', ['schedules'], ['t1']))).toContain('/team/attendance');
    expect(hrefs(me('org_admin', ['schedules']))).not.toContain('/team/attendance');
  });
});
