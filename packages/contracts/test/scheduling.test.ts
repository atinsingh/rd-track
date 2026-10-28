import { describe, expect, it } from 'vitest';
import {
  attendanceNeedsMarker,
  formatHours,
  isCalendarDate,
  isOvernight,
  shiftCreateRequest,
  shiftHours,
  shiftOverrideRequest,
  timeOffRequestCreate,
} from '../src';

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('scheduling helpers', () => {
  it('validates calendar dates', () => {
    expect(isCalendarDate('2026-11-01')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('26-11-01')).toBe(false);
  });

  it('treats an end at or before the start as the next day', () => {
    expect(isOvernight('22:00', '06:00')).toBe(true);
    expect(isOvernight('09:00', '17:00')).toBe(false);
    expect(shiftHours('22:00', '06:00')).toBe(8);
    expect(shiftHours('09:00', '17:30')).toBe(8.5);
    expect(formatHours(7.5)).toBe('7.5 h');
    expect(formatHours(8)).toBe('8 h');
  });

  it('marks only schedule exceptions, never on-schedule days', () => {
    expect(attendanceNeedsMarker('late')).toBe(true);
    expect(attendanceNeedsMarker('absent')).toBe(true);
    expect(attendanceNeedsMarker('on_time')).toBe(false);
    expect(attendanceNeedsMarker('on_leave')).toBe(false);
  });
});

describe('scheduling schemas', () => {
  const shift = { user_id: uuid, weekdays: [1, 2, 3], start_time: '09:00', end_time: '17:00', effective_from: '2026-10-01' };
  it('accepts a shift and rejects bad ones', () => {
    expect(shiftCreateRequest.safeParse(shift).success).toBe(true);
    expect(shiftCreateRequest.safeParse({ ...shift, weekdays: [1, 1] }).success).toBe(false);
    expect(shiftCreateRequest.safeParse({ ...shift, weekdays: [0] }).success).toBe(false);
    expect(shiftCreateRequest.safeParse({ ...shift, end_time: '09:00' }).success).toBe(false);
    expect(shiftCreateRequest.safeParse({ ...shift, start_time: '24:00' }).success).toBe(false);
    expect(shiftCreateRequest.safeParse({ ...shift, effective_to: '2026-09-30' }).success).toBe(false);
    expect(shiftCreateRequest.safeParse({ ...shift, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(shiftCreateRequest.safeParse({ ...shift, extra: 1 }).success).toBe(false);
  });

  it('needs times for a changed shift but not for a cancellation', () => {
    expect(shiftOverrideRequest.safeParse({ user_id: uuid, date: '2026-10-31', kind: 'cancel' }).success).toBe(true);
    expect(shiftOverrideRequest.safeParse({ user_id: uuid, date: '2026-10-31', kind: 'change' }).success).toBe(false);
  });

  it('allows part of a day only for a single day', () => {
    const base = { policy_id: uuid, start_date: '2026-11-02', end_date: '2026-11-02' };
    expect(timeOffRequestCreate.safeParse({ ...base, partial_hours: 4 }).success).toBe(true);
    expect(timeOffRequestCreate.safeParse({ ...base, end_date: '2026-11-03', partial_hours: 4 }).success).toBe(false);
    expect(timeOffRequestCreate.safeParse({ ...base, end_date: '2026-11-01' }).success).toBe(false);
  });
});
