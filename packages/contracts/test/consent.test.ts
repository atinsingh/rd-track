import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, renderAgreement, type PolicySettings } from '../src';

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
    });
    const text = renderAgreement({ organizationName: 'Acme', settings: [p], language: 'en' });
    expect(text).toContain('about one every 10 minutes');
    expect(text).toContain('blurred');
    expect(text).toContain('Website domains');
    expect(text).toContain('city, region and country');
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

  it('is written in French for French speakers', () => {
    const text = renderAgreement({ organizationName: 'Acme', settings: [DEFAULT_POLICY], language: 'fr' });
    expect(text).toContain('Entente de suivi');
    expect(text).toContain('Jamais recueilli');
  });
});
