import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, consentCovers, renderAgreement, type PolicySettings } from '../src';

const policy = (patch: (p: PolicySettings) => void): PolicySettings => {
  const p = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as PolicySettings;
  patch(p);
  return p;
};

describe('renderAgreement', () => {
  it('lists only what the policy collects', () => {
    const text = renderAgreement({ organizationName: 'Acme', settings: [DEFAULT_POLICY], language: 'en' });
    expect(text).toContain('Acme');
    expect(text).toContain('The name of the app in front');
    expect(text).not.toContain('Screenshots,');
    expect(text).not.toContain('IP address');
    expect(text).not.toContain('Website domains');
    expect(text).toContain('Activity: 90 days.');
    expect(text).not.toContain('Screenshots: ');
  });

  it('adds screenshots, domains and location when they are on, and is deterministic', () => {
    const p = policy((s) => {
      s.screenshots.enabled = true;
      s.screenshots.interval_minutes = 10;
      s.screenshots.blur = true;
      s.apps.capture_domains = true;
      s.location.capture = true;
      s.work_hours = { timezone: 'America/Toronto', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
    });
    const text = renderAgreement({ organizationName: 'Acme', settings: [p], language: 'en' });
    expect(text).toContain('about one every 10 minutes');
    expect(text).toContain('blurred');
    expect(text).toContain('Website domains');
    expect(text).toContain('city, region and country');
    expect(text).toContain('only for sessions that start during office hours');
    expect(text).toContain('deleted after 30 days');
    expect(text).toContain('Screenshots: 30 days.');
    expect(renderAgreement({ organizationName: 'Acme', settings: [p], language: 'en' })).toBe(text);
  });

  it('covers a project policy that collects more than the base one', () => {
    const project = policy((s) => {
      s.screenshots.enabled = true;
      s.screenshots.interval_minutes = 20;
    });
    const text = renderAgreement({ organizationName: 'Acme', settings: [DEFAULT_POLICY, project], language: 'en' });
    expect(text).toContain('about one every 20 minutes');
  });

  it('leaves location out without office hours: nothing is looked up then', () => {
    const p = policy((s) => {
      s.location.capture = true;
    });
    expect(renderAgreement({ organizationName: 'Acme', settings: [p], language: 'en' })).not.toContain('IP address');
  });

  it("keeps the admin's text and follows it with what is collected about this person", () => {
    const shots = policy((s) => {
      s.screenshots.enabled = true;
    });
    const plain = renderAgreement({ organizationName: 'Acme', settings: [DEFAULT_POLICY], language: 'en', customText: 'Our rules.' });
    const more = renderAgreement({ organizationName: 'Acme', settings: [shots], language: 'en', customText: 'Our rules.' });
    expect(plain.startsWith('Our rules.\n\nWhat is collected')).toBe(true);
    expect(plain).not.toContain('Never collected');
    expect(plain).toContain('Who can see it');
    expect(plain).toContain('Activity: 90 days.');
    expect(more).toContain('Screenshots, about one every');
    expect(more).not.toBe(plain);
  });

  it('is written in French for French speakers', () => {
    const text = renderAgreement({ organizationName: 'Acme', settings: [DEFAULT_POLICY], language: 'fr' });
    expect(text).toContain('Entente de suivi');
    expect(text).toContain('Jamais recueilli');
  });
});

describe('consentCovers', () => {
  const hours = { timezone: 'America/Toronto', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
  const shots = policy((s) => {
    s.screenshots.enabled = true;
  });

  it('covers collecting less, or the same split differently', () => {
    expect(consentCovers([shots], [DEFAULT_POLICY])).toBe(true);
    expect(consentCovers([DEFAULT_POLICY, shots], [shots])).toBe(true);
    expect(consentCovers([shots], [])).toBe(true);
  });

  it('asks again for anything collected beyond what was accepted, text or not', () => {
    expect(consentCovers([DEFAULT_POLICY], [DEFAULT_POLICY, shots])).toBe(false);
    expect(consentCovers([DEFAULT_POLICY], [policy((s) => (s.pause.max_minutes = DEFAULT_POLICY.pause.max_minutes - 5))])).toBe(false);
    expect(consentCovers([DEFAULT_POLICY], [policy((s) => (s.retention.activity_days += 30))])).toBe(false);
    const wider = policy((s) => {
      s.screenshots.enabled = true;
      s.screenshots.max_width_px = shots.screenshots.max_width_px * 2;
      s.screenshots.excluded_apps = [];
    });
    const withExcluded = policy((s) => {
      s.screenshots.enabled = true;
      s.screenshots.excluded_apps = ['1Password'];
    });
    expect(consentCovers([shots], [wider])).toBe(false);
    expect(consentCovers([withExcluded], [shots])).toBe(false);
  });

  it('asks again when office hours grow, and when location starts because office hours appear', () => {
    const office = policy((s) => (s.work_hours = hours));
    expect(consentCovers([office], [policy((s) => (s.work_hours = { ...hours, end: '16:00' }))])).toBe(true);
    expect(consentCovers([office], [policy((s) => (s.work_hours = { ...hours, end: '18:00' }))])).toBe(false);
    expect(consentCovers([office], [policy((s) => (s.work_hours = { ...hours, days: [1, 2, 3, 4, 5, 6] }))])).toBe(false);
    const locNoHours = policy((s) => (s.location.capture = true));
    const locHours = policy((s) => {
      s.location.capture = true;
      s.work_hours = hours;
    });
    expect(consentCovers([locNoHours], [locHours])).toBe(false);
  });
});
