import { describe, expect, it } from 'vitest';
import { addDays, dayRange, formatCountdown, formatDayLabel, formatTime, startOfWeek, toZonedInputs, zonedTimeToMs } from './time';

describe('time zone helpers', () => {
  it('computes a local day range', () => {
    expect(dayRange('2026-10-28', 'Europe/London')).toMatchObject({
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-10-29T00:00:00.000Z',
    });
    expect(dayRange('2026-07-01', 'Europe/London').from).toBe('2026-06-30T23:00:00.000Z');
    expect(dayRange('2026-10-28', 'America/New_York').from).toBe('2026-10-28T04:00:00.000Z');
  });

  it('handles DST transition days (23 and 25 hours)', () => {
    const spring = dayRange('2026-03-29', 'Europe/London');
    expect((spring.toMs - spring.fromMs) / 3_600_000).toBe(23);
    const autumn = dayRange('2026-10-25', 'Europe/London');
    expect((autumn.toMs - autumn.fromMs) / 3_600_000).toBe(25);
  });

  it('converts wall time to UTC and back', () => {
    const ms = zonedTimeToMs('2026-10-28', '08:12', 'Asia/Kolkata');
    expect(new Date(ms).toISOString()).toBe('2026-10-28T02:42:00.000Z');
    expect(formatTime(ms, 'Asia/Kolkata')).toBe('08:12');
    expect(toZonedInputs('2026-10-28T23:30:00Z', 'Europe/Berlin')).toEqual({ date: '2026-10-29', time: '00:30' });
  });

  it('does calendar arithmetic', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(startOfWeek('2026-10-28')).toBe('2026-10-26');
    expect(startOfWeek('2026-11-01')).toBe('2026-10-26');
    expect(formatDayLabel('2026-10-28')).toBe('Wed, 28 Oct 2026');
  });

  it('formats countdowns', () => {
    expect(formatCountdown(28 * 60_000 + 41_000)).toBe('28:41');
    expect(formatCountdown(-5)).toBe('00:00');
    expect(formatCountdown(3_600_000 + 1000)).toBe('1:00:01');
  });
});
