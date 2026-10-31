import { describe, expect, it } from 'vitest';
import {
  FAMILY_RULE_DEFAULTS,
  adultOn,
  ageOn,
  familyRulesSchema,
  partialFamilyRulesSchema,
  resolveFamilyRules,
  teenAge,
} from '../src/family';
import { PLANS } from '../src/plans';

describe('family rules', () => {
  it('the defaults are a valid rule set', () => {
    expect(familyRulesSchema.parse(FAMILY_RULE_DEFAULTS)).toEqual(FAMILY_RULE_DEFAULTS);
  });

  it('a child field wins over the family field, which wins over the default', () => {
    const family = { allow_requests: false, blocked_apps: ['com.roblox.client'] };
    const child = { blocked_apps: [] };
    const r = resolveFamilyRules(family, child);
    expect(r.rules.blocked_apps).toEqual([]);
    expect(r.sources.blocked_apps).toBe('child');
    expect(r.rules.allow_requests).toBe(false);
    expect(r.sources.allow_requests).toBe('family');
    expect(r.rules.web).toEqual(FAMILY_RULE_DEFAULTS.web);
    expect(r.sources.web).toBe('default');
  });

  it('documents are strict and validate what they set', () => {
    expect(partialFamilyRulesSchema.safeParse({ screenshots: true }).success).toBe(false);
    expect(partialFamilyRulesSchema.safeParse({ web: { block_adult: true } }).success).toBe(false); // a field is replaced whole
    expect(
      partialFamilyRulesSchema.safeParse({
        web: { block_adult: true, safe_search: true, blocked_domains: ['https://x.com/a'], allowed_domains: [] },
      }).success,
    ).toBe(false);
    expect(
      partialFamilyRulesSchema.safeParse({
        routines: [{ id: 'school', kind: 'school', name: 'School', days: ['mon'], start: '08:30', end: '15:00' }],
      }).success,
    ).toBe(true);
    expect(partialFamilyRulesSchema.safeParse({ daily_budget: { ...FAMILY_RULE_DEFAULTS.daily_budget, mon: 1441 } }).success).toBe(false);
  });
});

describe('ages', () => {
  it('counts whole years from the first of the birth month', () => {
    expect(ageOn(2014, 5, new Date('2027-04-30T12:00:00Z'))).toBe(12);
    expect(ageOn(2014, 5, new Date('2027-05-01T00:00:00Z'))).toBe(13);
  });

  it('teens start at 13, or 14 in Québec, and profiles end at 18', () => {
    expect(teenAge('CA')).toBe(13);
    expect(teenAge('CA-QC')).toBe(14);
    expect(adultOn(2014, 5)).toBe('2032-05-01');
  });

  it('the family plan never allows screenshots, domains or window titles', () => {
    expect(PLANS.family.policyScope.screenshots?.enabled).toBe(false);
    expect(PLANS.family.policyScope.apps?.capture_domains).toBe(false);
    expect(PLANS.family.policyScope.apps?.capture_window_titles).toBe(false);
    expect(PLANS.family.max_billable_seats).toBe(5);
  });
});
