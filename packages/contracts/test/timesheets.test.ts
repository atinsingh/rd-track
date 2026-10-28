import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  computeOvertime,
  isCalendarDate,
  isoWeekStart,
  periodStartSchema,
  weekDates,
  weeksBetween,
  workLimitsUpdateRequest,
} from '../src';

describe('ISO week helpers', () => {
  it('finds the Monday of a week, across month and year ends', () => {
    expect(isoWeekStart('2026-10-28')).toBe('2026-10-26');
    expect(isoWeekStart('2026-11-01')).toBe('2026-10-26'); // Sunday belongs to the week before
    expect(isoWeekStart('2026-10-26')).toBe('2026-10-26');
    expect(isoWeekStart('2027-01-01')).toBe('2026-12-28');
  });
  it('lists the seven dates and the weeks in a range', () => {
    expect(weekDates('2026-10-26')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(weeksBetween('2026-10-28', '2026-11-10')).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
  });
  it('validates dates and Monday period starts', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(periodStartSchema.safeParse('2026-10-26').success).toBe(true);
    expect(periodStartSchema.safeParse('2026-10-27').success).toBe(false);
    expect(periodStartSchema.safeParse('2026-13-01').success).toBe(false);
  });
});

describe('computeOvertime', () => {
  const h = (n: number) => n * 3600;

  it('counts time over the daily limit per day', () => {
    const r = computeOvertime([h(9), h(8), h(7.5), 0, 0, 0, 0], { daily_minutes: 480, weekly_minutes: null });
    expect(r.per_day_seconds).toEqual([h(1), 0, 0, 0, 0, 0, 0]);
    expect(r).toMatchObject({ daily_overtime_seconds: h(1), weekly_overtime_seconds: 0, overtime_seconds: h(1) });
  });

  it('counts weekly overtime without double counting daily overtime', () => {
    // 5 × 9h = 45h. Daily limit 8h → 5h daily overtime; the remaining 40h is not over 40h.
    const five = [h(9), h(9), h(9), h(9), h(9), 0, 0];
    expect(computeOvertime(five, { daily_minutes: 480, weekly_minutes: 2400 }).overtime_seconds).toBe(h(5));
    // Weekly only: 45h over 40h = 5h.
    expect(computeOvertime(five, { daily_minutes: null, weekly_minutes: 2400 })).toMatchObject({
      daily_overtime_seconds: 0,
      weekly_overtime_seconds: h(5),
    });
    // Six 8h days: no daily overtime, 8h weekly overtime.
    const six = [h(8), h(8), h(8), h(8), h(8), h(8), 0];
    expect(computeOvertime(six, { daily_minutes: 480, weekly_minutes: 2400 })).toMatchObject({
      daily_overtime_seconds: 0,
      weekly_overtime_seconds: h(8),
      overtime_seconds: h(8),
    });
  });

  it('is zero without limits', () => {
    expect(computeOvertime([h(12)], { daily_minutes: null, weekly_minutes: null }).overtime_seconds).toBe(0);
  });
});

describe('workLimitsUpdateRequest', () => {
  it('accepts defaults and overrides, and rejects out-of-range values', () => {
    expect(
      workLimitsUpdateRequest.safeParse({
        organization: { daily_minutes: 480, weekly_minutes: 2400 },
        users: [{ user_id: '0b8a2c47-3f43-4a51-9d0f-5f1f4f3f9a11', limits: null }],
      }).success,
    ).toBe(true);
    expect(workLimitsUpdateRequest.safeParse({ organization: { daily_minutes: 0, weekly_minutes: null } }).success).toBe(false);
    expect(workLimitsUpdateRequest.safeParse({ organization: { daily_minutes: 1441, weekly_minutes: null } }).success).toBe(false);
  });
});
