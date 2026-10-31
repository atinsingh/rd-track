import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  PLANS,
  collectionExpansions,
  resolvePolicy,
  seatCeiling,
  type PolicyScopeInput,
} from '../src';

const org = (settings: PolicyScopeInput['settings']): PolicyScopeInput => ({
  scope_type: 'organization',
  scope_id: 'org',
  name: 'RoundDigital',
  settings,
});
const team = (id: string, settings: PolicyScopeInput['settings']): PolicyScopeInput => ({
  scope_type: 'team',
  scope_id: id,
  name: `Team ${id}`,
  settings,
});
const project = (settings: PolicyScopeInput['settings']): PolicyScopeInput => ({
  scope_type: 'project',
  scope_id: 'p1',
  name: 'Client A',
  settings,
});

describe('resolvePolicy', () => {
  it('returns privacy-preserving defaults with no scopes', () => {
    const { settings, sources } = resolvePolicy([]);
    expect(settings).toEqual(DEFAULT_POLICY);
    expect(settings.screenshots.enabled).toBe(false);
    expect(sources['screenshots.enabled']).toEqual([]);
  });

  it('blurs screenshots when any scope asks, and treats unblurring as collecting more', () => {
    const on = { screenshots: { enabled: true } };
    expect(resolvePolicy([org(on)]).settings.screenshots.blur).toBe(false);
    const { settings, sources } = resolvePolicy([org({ screenshots: { enabled: true, blur: false } }), team('t1', { screenshots: { blur: true } })]);
    expect(settings.screenshots.blur).toBe(true);
    expect(sources['screenshots.blur']?.map((s) => s.scope_type)).toEqual(['team']);
    const blurred = resolvePolicy([org({ screenshots: { enabled: true, blur: true } })]).settings;
    const sharp = resolvePolicy([org(on)]).settings;
    expect(collectionExpansions(blurred, sharp)).toEqual([{ field: 'screenshots.blur', from: true, to: false }]);
    expect(collectionExpansions(sharp, blurred)).toEqual([]);
  });

  it('lets one project turn screenshots on without enabling them org-wide', () => {
    const { settings, sources } = resolvePolicy([org({}), project({ screenshots: { enabled: true } })]);
    expect(settings.screenshots.enabled).toBe(true);
    expect(sources['screenshots.enabled']).toEqual([{ scope_type: 'project', scope_id: 'p1', name: 'Client A' }]);
    expect(resolvePolicy([org({})]).settings.screenshots.enabled).toBe(false);
  });

  it('gives any explicit false a veto over explicit true', () => {
    const { settings, sources } = resolvePolicy([
      project({ screenshots: { enabled: true } }),
      team('b', { screenshots: { enabled: false } }),
    ]);
    expect(settings.screenshots.enabled).toBe(false);
    expect(sources['screenshots.enabled']![0]!.scope_id).toBe('b');
  });

  it('resolves numbers toward less collection', () => {
    const { settings } = resolvePolicy([
      org({ screenshots: { interval_minutes: 10, max_width_px: 1920 }, retention: { screenshot_days: 60 } }),
      team('support', { retention: { screenshot_days: 14 } }),
      project({ screenshots: { interval_minutes: 15, max_width_px: 1280 } }),
    ]);
    expect(settings.screenshots.interval_minutes).toBe(15);
    expect(settings.screenshots.max_width_px).toBe(1280);
    expect(settings.retention.screenshot_days).toBe(14);
  });

  it('unions excluded apps and takes the most specific idle threshold', () => {
    const { settings } = resolvePolicy([
      org({ idle: { threshold_seconds: 300 }, screenshots: { excluded_apps: ['1Password'] } }),
      team('a', { idle: { threshold_seconds: 180 }, screenshots: { excluded_apps: ['Signal'] } }),
      team('b', { idle: { threshold_seconds: 240 } }),
    ]);
    expect(settings.screenshots.excluded_apps).toEqual(['1Password', 'Signal']);
    // two teams at the same level: the longer (more lenient) threshold wins
    expect(settings.idle.threshold_seconds).toBe(240);
  });

  it('applies the plan as an always-restrictive scope', () => {
    const scopes = [project({ screenshots: { enabled: true }, retention: { activity_days: 365 } })];
    const standard = resolvePolicy([...scopes, { scope_type: 'plan', scope_id: 'standard', settings: PLANS.standard.policyScope }]);
    expect(standard.settings.screenshots.enabled).toBe(false);
    expect(standard.settings.retention.activity_days).toBe(90);
    const pro = resolvePolicy([...scopes, { scope_type: 'plan', scope_id: 'pro', settings: PLANS.pro.policyScope }]);
    expect(pro.settings.screenshots.enabled).toBe(true);
    expect(pro.settings.retention.activity_days).toBe(365);
  });

  it('takes the most specific work hours', () => {
    const wh = { timezone: 'Europe/London', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:30' };
    const { settings } = resolvePolicy([
      org({ work_hours: { ...wh, start: '08:00' } }),
      project({ work_hours: wh }),
    ]);
    expect(settings.work_hours).toEqual(wh);
  });
});

describe('collectionExpansions', () => {
  const base = DEFAULT_POLICY;
  it('flags turning screenshots on', () => {
    const next = { ...base, screenshots: { ...base.screenshots, enabled: true } };
    expect(collectionExpansions(base, next).map((c) => c.field)).toEqual(['screenshots.enabled']);
  });
  it('flags more frequent screenshots and longer retention', () => {
    const on = { ...base, screenshots: { ...base.screenshots, enabled: true } };
    const more = {
      ...on,
      screenshots: { ...on.screenshots, interval_minutes: 10 },
      retention: { ...on.retention, screenshot_days: 60, activity_days: 120 },
    };
    expect(collectionExpansions(on, more).map((c) => c.field).sort()).toEqual([
      'retention.activity_days',
      'retention.screenshot_days',
      'screenshots.interval_minutes',
    ]);
  });
  it('treats restrictions as neutral', () => {
    const less = {
      ...base,
      apps: { ...base.apps, capture_app_name: false },
      retention: { ...base.retention, activity_days: 30 },
    };
    expect(collectionExpansions(base, less)).toEqual([]);
  });
  it('flags a manager gaining screenshot access', () => {
    const next = { ...base, viewers: { ...base.viewers, manager_can_view_screenshots: true } };
    expect(collectionExpansions(base, next)).toHaveLength(1);
  });
});

describe('seatCeiling', () => {
  it('caps free at two seats with no overage', () => {
    expect(seatCeiling('free', 0)).toBe(2);
  });
  it('allows the larger of 2 seats or 10% overage on paid plans', () => {
    expect(seatCeiling('standard', 10)).toBe(12);
    expect(seatCeiling('pro', 100)).toBe(110);
  });
});
