import { languageOf, matchLocale, type AppLanguage, type AppLocale } from '@rd/contracts';
import { useSyncExternalStore } from 'react';

/**
 * Language and formats (G27). One locale for the whole page: the person's choice, else
 * their organization's, else the browser's. Formatting helpers and `t()` read it, so it is
 * set before the signed-in app renders (MeProvider) and changing it reloads the page.
 */

/** What the server renders with, and the fallback when the browser offers nothing we have. */
export const DEFAULT_LOCALE: AppLocale = 'en-US';

let current: AppLocale = typeof navigator === 'undefined' ? DEFAULT_LOCALE : browserLocale();
const listeners = new Set<() => void>();

export function browserLocale(): AppLocale {
  try {
    return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export const currentLocale = (): AppLocale => current;
export const currentLanguage = (): AppLanguage => languageOf(current);

/**
 * Switches the page's locale. During a render, pass `announce: false` (so components
 * elsewhere aren't updated mid-render) and call announceLocale() from an effect.
 */
export function setLocale(l: AppLocale, announce = true) {
  if (l === current) return;
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  if (announce) announceLocale();
}

/** Tells components that read the locale with useLocale()/useT() to render again. */
export function announceLocale() {
  for (const f of listeners) f();
}

/** The locale for someone signed in: theirs, their organization's, or the browser's. */
export const resolveLocale = (own: AppLocale | null | undefined, org: AppLocale | null | undefined): AppLocale => own ?? org ?? browserLocale();

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** The current locale, safe to use on pages the server renders first (they hydrate in the default, then switch). */
export function useLocale(): AppLocale {
  return useSyncExternalStore(subscribe, currentLocale, () => DEFAULT_LOCALE);
}
