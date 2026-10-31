import { describe, expect, it } from 'vitest';
import { lang } from '../src/i18n';
import { en } from '../src/i18n/messages/en';
import { fr } from '../src/i18n/messages/fr';

/** G27: what the server writes, in each reader's language. */

describe('server catalogue', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('French has every key, filled in, with the same placeholders', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(fr[key], key).toBeTruthy();
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('writes dates and money the reader’s way', () => {
    const sp = (s: string) => s.replace(/[  ]/g, ' ');
    expect(lang('en-US').day('2026-10-28')).toBe('Oct 28, 2026');
    expect(sp(lang('fr-CA').day('2026-10-28'))).toBe('28 oct. 2026');
    expect(sp(lang('fr-CA').money(123450, 'CAD'))).toBe('1 234,50 $');
    expect(lang('en-GB').dueTime(Date.parse('2026-11-02T15:00:00Z'), 'America/Toronto')).toBe('Mon 2 Nov, 10:00');
    expect(lang('fr-CA').t('ev.correctionSubmitted.title', { name: 'Jun' })).toBe('Jun a demandé de corriger son temps');
  });
});
