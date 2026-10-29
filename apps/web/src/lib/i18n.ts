import { languageOf, SSO_ERRORS, type AppLanguage, type AppLocale, type SsoErrorCode } from '@rd/contracts';
import { en, type MessageKey } from './messages/en';
import { fr } from './messages/fr';
import { currentLanguage, useLocale } from './locale';

/**
 * Translations (G27). English is the source; every other language must have every key
 * (the compiler checks). `{name}` placeholders are filled from `vars`. Text not yet moved
 * into the catalogue stays in English.
 */

const CATALOGUES: Record<AppLanguage, Record<MessageKey, string>> = { en, fr };

export type Vars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

export function translate(lang: AppLanguage, key: MessageKey, vars?: Vars): string {
  return fill(CATALOGUES[lang][key] ?? en[key], vars);
}

/** In the current language; for helpers outside components (nav labels, formatting). */
export const t: Translate = (key, vars) => translate(currentLanguage(), key, vars);

/** In a given locale's language, for documents written in someone else's (an agency's invoice). */
export const tFor = (locale: AppLocale): Translate => (key, vars) => translate(languageOf(locale), key, vars);

/** For components; re-renders when the language changes, and hydrates safely. */
export function useT(): Translate {
  const lang = languageOf(useLocale());
  return (key, vars) => translate(lang, key, vars);
}

export type { MessageKey };

/** Why a sign-in through the identity provider failed, in the reader's language. */
export const ssoErrorText = (tr: Translate, code: SsoErrorCode): string => (code in SSO_ERRORS ? tr(`sso.error.${code}` as MessageKey) : '');
