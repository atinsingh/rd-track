import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, describeCollection, matchLocale, type PolicySettings } from '@rd/contracts';
import { formatMoney, formatNumber, formatPercent, formatPrice } from './format';
import { t, translate } from './i18n';
import { setLocale } from './locale';
import { en } from './messages/en';
import { fr } from './messages/fr';
import { centsToInput, parseHoursInput, parseMoneyInput, parsePercentBp } from './money';
import { describeCollectionLocalized, viewerSees } from './privacy';
import { formatDayLabel, formatHour, formatRelative, formatTime, weekdayShort } from './time';

afterEach(() => setLocale('en-GB'));

const at = Date.parse('2026-10-28T13:05:00Z');
/** French puts (narrow) non-breaking spaces in numbers and before % and $; compare them as spaces. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('locales', () => {
  it('picks the closest supported locale from the browser', () => {
    expect(matchLocale(['fr-CA', 'en'])).toBe('fr-CA');
    expect(matchLocale(['fr-BE'])).toBe('fr-CA');
    expect(matchLocale(['en-NZ'])).toBe('en-US');
    expect(matchLocale(['de-DE', 'en-GB'])).toBe('en-GB');
    expect(matchLocale(['de-DE'])).toBeNull();
  });

  it('writes dates, times, numbers and money the way the locale does', () => {
    setLocale('fr-CA');
    expect(sp(formatDayLabel('2026-10-28'))).toBe('mer. 28 oct. 2026');
    expect(sp(formatTime(at, 'America/Toronto'))).toBe('09 h 05');
    expect(sp(formatMoney(123450, 'CAD'))).toBe('1 234,50 $');
    expect(formatNumber(7.25)).toBe('7,25');
    expect(sp(formatPercent(42))).toBe('42 %');
    expect(weekdayShort(1)).toBe('lun.');
    setLocale('en-US');
    expect(formatDayLabel('2026-10-28')).toBe('Wed, Oct 28, 2026');
    expect(formatTime(at, 'America/Toronto')).toBe('9:05 AM');
    expect(formatHour(at, 'America/Toronto')).toBe('9 AM');
    expect(formatPrice(500, 'USD')).toBe('$5');
    expect(formatMoney(123450)).toBe('$1,234.50');
    setLocale('en-GB');
    expect(formatHour(at, 'America/Toronto')).toBe('09');
  });

  it('reads amounts typed the local way, and never mistakes a decimal comma for thousands', () => {
    setLocale('fr-CA');
    expect(parseMoneyInput('1 234,50')).toBe(123_450);
    expect(parseMoneyInput('12,5')).toBe(1250);
    expect(parseMoneyInput('12.5')).toBe(1250);
    expect(parseHoursInput('1,5')).toBe(1.5);
    expect(parsePercentBp('8,25 %')).toBe(825);
    expect(centsToInput(123450)).toBe('1234,50');
    setLocale('en-US');
    expect(parseMoneyInput('1,234.50')).toBe(123_450);
    expect(parseHoursInput('1,5')).toBeNull();
    expect(centsToInput(123450)).toBe('1234.50');
  });

  it('says relative times in the language', () => {
    setLocale('fr-CA');
    const now = Date.parse('2026-10-28T15:00:00Z');
    expect(formatRelative('2026-10-28T14:59:30Z', 'UTC', now)).toBe('à l’instant');
    expect(sp(formatRelative('2026-10-28T09:00:00Z', 'UTC', now))).toBe('Aujourd’hui 09 h 00');
  });
});

describe('translations', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('French has every key, filled in, with the same placeholders', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(fr[key], key).toBeTruthy();
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('fills placeholders and follows the current language', () => {
    expect(translate('fr', 'notifications.unread', { n: 3 })).toBe('3 non lues');
    setLocale('fr-FR');
    expect(t('nav.myDay')).toBe('Ma journée');
    setLocale('en-CA');
    expect(t('nav.myDay')).toBe('My day');
  });

  it("keeps What's collected word for word the shared English the desktop app shows", () => {
    const variants: PolicySettings[] = [
      DEFAULT_POLICY,
      {
        ...DEFAULT_POLICY,
        apps: { ...DEFAULT_POLICY.apps, capture_app_name: true, capture_domains: true, capture_window_titles: true },
        screenshots: { ...DEFAULT_POLICY.screenshots, enabled: true, primary_monitor_only: false, excluded_apps: ['com.apple.mail'] },
      },
      { ...DEFAULT_POLICY, screenshots: { ...DEFAULT_POLICY.screenshots, enabled: true, primary_monitor_only: true, excluded_apps: [] } },
    ];
    for (const p of variants) expect(describeCollectionLocalized(p)).toEqual(describeCollection(p));
    setLocale('fr-CA');
    expect(describeCollectionLocalized(DEFAULT_POLICY)[0]!.text).toBe('Le début, les pauses et la fin de votre session');
    expect(viewerSees('time on Client A')).toBe('le temps sur Client A');
  });
});
