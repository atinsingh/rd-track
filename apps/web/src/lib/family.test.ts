import { describe, expect, it } from 'vitest';
import { FAMILY_RULE_DEFAULTS } from '@rd/contracts';
import {
  budgetState,
  crossesMidnight,
  effective,
  inherit,
  normalizeDomain,
  override,
  parseList,
  pauseUntilMorning,
  pausedNow,
  resolvedOf,
  routineId,
  sameDoc,
  sets,
} from './family';

describe('family editor', () => {
  const base = FAMILY_RULE_DEFAULTS;

  it('a field the document does not set follows the base', () => {
    expect(effective({}, base, 'allow_requests')).toBe(true);
    expect(sets({}, 'allow_requests')).toBe(false);
  });

  it('setting a field overrides it, and inheriting removes it again', () => {
    const doc = override({}, 'allow_requests', false);
    expect(effective(doc, base, 'allow_requests')).toBe(false);
    expect(sets(doc, 'allow_requests')).toBe(true);
    const back = inherit(doc, 'allow_requests');
    expect(back).toEqual({});
    expect(doc).toEqual({ allow_requests: false }); // copies, never in place
  });

  it('resolves the whole set and compares documents by content', () => {
    const doc = { blocked_apps: ['com.roblox.client'] };
    expect(resolvedOf(doc, base).blocked_apps).toEqual(['com.roblox.client']);
    expect(resolvedOf(doc, base).web).toEqual(base.web);
    expect(sameDoc({ allow_requests: true, blocked_apps: [] }, { blocked_apps: [], allow_requests: true })).toBe(true);
    expect(sameDoc({ allow_requests: true }, {})).toBe(false);
  });
});

describe('family helpers', () => {
  it('budget meter: share used, over, and minutes left', () => {
    expect(budgetState(60, 120)).toEqual({ pct: 50, over: false, left: 60 });
    expect(budgetState(150, 120)).toEqual({ pct: 100, over: true, left: 0 });
    expect(budgetState(30, null)).toEqual({ pct: 0, over: false, left: null });
    expect(budgetState(0, 0)).toEqual({ pct: 100, over: false, left: 0 });
  });

  it('a routine ending at or before its start runs past midnight', () => {
    expect(crossesMidnight({ start: '21:00', end: '07:00' })).toBe(true);
    expect(crossesMidnight({ start: '08:30', end: '15:00' })).toBe(false);
  });

  it('new routine ids are unique', () => {
    expect(routineId('school', [])).toBe('school');
    expect(routineId('school', ['school', 'school-2'])).toBe('school-3');
  });

  it('lists and domains typed by a parent', () => {
    expect(parseList('a, b\n\nb\n c ')).toEqual(['a', 'b', 'c']);
    expect(normalizeDomain('https://www.Example.com/path?q=1')).toBe('example.com');
    expect(normalizeDomain('khanacademy.org')).toBe('khanacademy.org');
    expect(normalizeDomain('not a domain')).toBeNull();
  });

  it('pausing until the morning means 07:00 tomorrow where the family lives', () => {
    const now = Date.parse('2026-10-31T23:30:00Z'); // 19:30 in Montréal
    expect(pauseUntilMorning('America/Toronto', now)).toBe('2026-11-01T12:00:00.000Z'); // clocks went back at 02:00: 07:00 is EST
    expect(pausedNow('2026-11-01T12:00:00.000Z', now)).toBe(true);
    expect(pausedNow(null, now)).toBe(false);
  });
});
