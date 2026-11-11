import { z } from 'zod';

// Language and formats (G27). A locale sets both the language Track's screens use and how
// dates, times, numbers and money are written. Screens not yet translated stay in English.

export const LOCALES = ['en-US', 'en-CA', 'en-GB', 'en-AU', 'en-IN', 'fr-CA', 'fr-FR'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

/** Each locale named in its own language, so people can find theirs. */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  'en-US': 'English (United States)',
  'en-CA': 'English (Canada)',
  'en-GB': 'English (United Kingdom)',
  'en-AU': 'English (Australia)',
  'en-IN': 'English (India)',
  'fr-CA': 'Français (Canada)',
  'fr-FR': 'Français (France)',
};

export type AppLanguage = 'en' | 'fr';
export const languageOf = (l: AppLocale): AppLanguage => (l.startsWith('fr') ? 'fr' : 'en');

/** The closest supported locale to a browser's preferences (`navigator.languages`), if any. */
export function matchLocale(preferred: readonly string[]): AppLocale | null {
  for (const p of preferred) {
    const exact = LOCALES.find((l) => l.toLowerCase() === p.toLowerCase());
    if (exact) return exact;
    const lang = p.slice(0, 2).toLowerCase();
    // A language without our region: Canada first for French, the US for English.
    if (lang === 'fr') return 'fr-CA';
    if (lang === 'en') return 'en-US';
  }
  return null;
}

/** Set the person's own (or, for an admin, the organization's default); null follows the default. */
export const localeSetRequest = z.strictObject({ locale: localeSchema.nullable() });
