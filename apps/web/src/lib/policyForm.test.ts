import { describe, expect, it } from 'vitest';
import { POLICY_FIELD_RULES, type PartialPolicySettings } from '@rd/contracts';
import {
  POLICY_FIELDS,
  describeChange,
  describeSources,
  diffPartials,
  formFromPartial,
  formatFieldValue,
  partialFromForm,
  sameSettings,
} from './policyForm';

describe('policy form conversion', () => {
  it('has one editor field per resolver rule, in rule order', () => {
    expect(POLICY_FIELDS).toHaveLength(POLICY_FIELD_RULES.length);
    expect(POLICY_FIELDS[0]!.key).toBe('screenshots.enabled');
    expect(POLICY_FIELDS.every((f) => f.label !== f.key)).toBe(true);
  });

  it('an empty document round-trips to an empty document', () => {
    const form = formFromPartial({});
    expect(Object.values(form).every((f) => !f.set)).toBe(true);
    expect(partialFromForm(form)).toEqual({ settings: {}, errors: {} });
  });

  it('round-trips every kind of field', () => {
    const doc: PartialPolicySettings = {
      screenshots: { enabled: true, interval_minutes: 15, excluded_apps: ['1Password', 'Signal'], employee_deletion: 'review' },
      viewers: { manager_can_view_screenshots: false },
      idle: { threshold_seconds: 300 },
      work_hours: { timezone: 'Europe/London', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:30' },
      retention: { screenshot_days: 14 },
    };
    const { settings, errors } = partialFromForm(formFromPartial(doc));
    expect(errors).toEqual({});
    expect(sameSettings(settings, doc)).toBe(true);
  });

  it('omits unset fields and empty groups', () => {
    const form = formFromPartial({});
    form['apps.capture_domains'] = { ...form['apps.capture_domains']!, set: true, bool: false };
    form['retention.activity_days'] = { ...form['retention.activity_days']!, set: false, text: '30' };
    expect(partialFromForm(form).settings).toEqual({ apps: { capture_domains: false } });
  });

  it('reports range and format errors per field', () => {
    const form = formFromPartial({});
    form['screenshots.interval_minutes'] = { ...form['screenshots.interval_minutes']!, set: true, text: '5' };
    form['retention.activity_days'] = { ...form['retention.activity_days']!, set: true, text: 'abc' };
    form.work_hours = { ...form.work_hours!, set: true, wh: { timezone: 'UTC', days: [], start: '09:00', end: '17:00' } };
    const { errors } = partialFromForm(form);
    expect(errors['screenshots.interval_minutes']).toMatch(/between 10 and 60/);
    expect(errors['retention.activity_days']).toBe('Enter a whole number');
    expect(errors.work_hours).toBe('Choose at least one day');
  });

  it('dedupes and trims list entries', () => {
    const form = formFromPartial({});
    form['screenshots.excluded_apps'] = { ...form['screenshots.excluded_apps']!, set: true, text: ' Slack \n\nSlack, Zoom' };
    expect(partialFromForm(form).settings).toEqual({ screenshots: { excluded_apps: ['Slack', 'Zoom'] } });
  });
});

describe('policy explanations', () => {
  const scope = { scope_type: 'project' as const, scope_id: 'p1' };
  it('explains where an effective value comes from', () => {
    expect(describeSources([], scope)).toBe('Default — no scope sets it');
    expect(describeSources([{ scope_type: 'project', scope_id: 'p1', name: 'Client A' }], scope)).toBe('Because this scope sets it');
    expect(
      describeSources(
        [
          { scope_type: 'team', scope_id: 't1', name: 'Support' },
          { scope_type: 'plan', scope_id: 'standard' },
        ],
        scope,
      ),
    ).toBe('Because Team Support and your plan set it');
  });

  it('formats values and expansion changes in plain language', () => {
    expect(formatFieldValue('screenshots.enabled', true)).toBe('On');
    expect(formatFieldValue('idle.threshold_seconds', 300)).toBe('5 min');
    expect(formatFieldValue('retention.screenshot_days', 30)).toBe('30 days');
    expect(formatFieldValue('work_hours', null)).toBe('No limit');
    expect(formatFieldValue('work_hours', { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' })).toBe(
      'Mon–Fri 09:00–17:00 (UTC)',
    );
    expect(describeChange({ field: 'screenshots.enabled', from: false, to: true })).toBe('Screenshots: off → on');
  });

  it('diffs stored and edited documents', () => {
    const diff = diffPartials({ screenshots: { enabled: false } }, { screenshots: { enabled: true }, idle: { threshold_seconds: 600 } });
    expect(diff).toEqual([
      { key: 'screenshots.enabled', label: 'Screenshots', from: 'Off', to: 'On' },
      { key: 'idle.threshold_seconds', label: 'Idle after', from: 'Not set', to: '10 min' },
    ]);
  });
});
