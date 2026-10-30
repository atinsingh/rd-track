import type { BrowserFamily } from '@rd/contracts';
import { currentLocale } from './locale';

/** The Track extension's IDs, for browser policies (see agent/browser-extension). */
export const EXTENSION_IDS = { chromium: 'gagmoddppfppofnboknnmkiakhjmacln', firefox: 'browser@track.round.digital' } as const;

const NAMES: Record<BrowserFamily, string> = { chromium: 'Chrome/Edge', firefox: 'Firefox' };
export const STORE_NAMES = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' } as const;

/** "Chrome/Edge and Firefox", in the reader's language. */
export function browserList(families: readonly BrowserFamily[]): string {
  return new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(families.map((f) => NAMES[f]));
}
