import { describe, expect, it } from 'vitest';
import { byName, durationOrDash, formatDuration, formatHoursShort, formatMoney, initials, percentOrDash } from './format';

describe('duration formatting', () => {
  it('formats hours and zero-padded minutes', () => {
    expect(formatDuration(0)).toBe('0h 00m');
    expect(formatDuration(6 * 3600 + 42 * 60)).toBe('6h 42m');
    expect(formatDuration(36 * 3600 + 10 * 60 + 29)).toBe('36h 10m');
    expect(formatDuration(-10)).toBe('0h 00m');
  });
  it('uses a dash for empty table cells', () => {
    expect(durationOrDash(0)).toBe('—');
    expect(durationOrDash(null)).toBe('—');
    expect(durationOrDash(1800)).toBe('0h 30m');
  });
  it('formats short chart labels', () => {
    expect(formatHoursShort(45 * 60)).toBe('45m');
    expect(formatHoursShort(36 * 3600)).toBe('36h');
    expect(formatHoursShort(7.5 * 3600)).toBe('7.5h');
  });
});

describe('misc formatting', () => {
  it('formats percent, money and initials', () => {
    expect(percentOrDash(null)).toBe('—');
    expect(percentOrDash(70.6)).toBe('71%');
    expect(formatMoney(250)).toBe('$2.50');
    expect(formatMoney(123450)).toBe('$1,234.50');
    expect(initials('Priya Nair')).toBe('PN');
    expect(initials('cher')).toBe('C');
  });
  it('sorts by name, not by any metric', () => {
    const rows = [{ display_name: 'tom' }, { display_name: 'Alex' }, { display_name: 'dana' }];
    expect([...rows].sort(byName).map((r) => r.display_name)).toEqual(['Alex', 'dana', 'tom']);
  });
});
