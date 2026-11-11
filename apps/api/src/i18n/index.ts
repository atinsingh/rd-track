import { languageOf, type AppLanguage, type AppLocale } from '@rd/contracts';
import { many, one, type Queryable } from '../db/pool';
import { en, type ServerMessageKey } from './messages/en';
import { fr } from './messages/fr';

/**
 * Text the server writes for people — notifications, to-dos, emails — in each reader's
 * language and formats (G27): theirs, else their organization's, else English. The web's
 * own catalogue covers its screens; this one only what is written here.
 */

export const SERVER_DEFAULT_LOCALE: AppLocale = 'en-US';

const CATALOGUES: Record<AppLanguage, Record<ServerMessageKey, string>> = { en, fr };

export type Vars = Record<string, string | number>;

/** Everything needed to write for one reader. */
export interface Lang {
  locale: AppLocale;
  t(key: ServerMessageKey, vars?: Vars): string;
  /** "28 Oct 2026" / "Oct 28, 2026" / "28 oct. 2026" for an instant or a calendar day. */
  day(isoOrDate: string): string;
  /** "19 Oct" for a calendar day. */
  dayMonth(date: string): string;
  /** "Mon 26 Oct, 10:00" in `tz`. */
  dueTime(ms: number, tz: string): string;
  money(cents: number, currency: string): string;
  number(n: number, decimals?: number): string;
}

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** A date-only value ("2026-10-28") is a calendar day; anything else an instant. */
const asDate = (v: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);

const cache = new Map<AppLocale, Lang>();
export function lang(locale: AppLocale): Lang {
  const hit = cache.get(locale);
  if (hit) return hit;
  const messages = CATALOGUES[languageOf(locale)];
  const h24 = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle === 'h23';
  const l: Lang = {
    locale,
    t: (key, vars) => fill(messages[key] ?? en[key], vars),
    day: (v) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(asDate(v)),
    dayMonth: (v) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(asDate(v)),
    dueTime: (ms, tz) =>
      new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: h24 ? '2-digit' : 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(ms)),
    money: (cents, currency) => new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100),
    number: (n, decimals) =>
      new Intl.NumberFormat(locale, decimals === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n),
  };
  cache.set(locale, l);
  return l;
}

/** Text that is either fixed or written for each reader. */
export type Localized = string | ((l: Lang) => string);
export const render = (v: Localized, l: Lang): string => (typeof v === 'string' ? v : v(l));

/**
 * Each person's locale: their own, else their organization's, else English. With
 * `withoutDefault`, people who have neither are left out (their computer decides).
 */
export async function localesOf(q: Queryable, userIds: readonly string[], opts: { withoutDefault?: boolean } = {}): Promise<Map<string, AppLocale>> {
  if (userIds.length === 0) return new Map();
  const rows = await many<{ id: string; locale: AppLocale | null; org_locale: AppLocale | null }>(
    q,
    'SELECT u.id, u.locale, o.locale AS org_locale FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ANY($1::uuid[])',
    [userIds],
  );
  const out = new Map<string, AppLocale>();
  for (const r of rows) {
    const l = r.locale ?? r.org_locale ?? (opts.withoutDefault ? null : SERVER_DEFAULT_LOCALE);
    if (l) out.set(r.id, l);
  }
  return out;
}

export async function langOfUser(q: Queryable, userId: string): Promise<Lang> {
  return lang((await localesOf(q, [userId])).get(userId) ?? SERVER_DEFAULT_LOCALE);
}

/** For someone without an account of their own yet (an invite, a client): the organization's choice. */
export async function langOfOrg(q: Queryable, orgId: string): Promise<Lang> {
  const o = await one<{ locale: AppLocale | null }>(q, 'SELECT locale FROM organizations WHERE id = $1', [orgId]);
  return lang(o?.locale ?? SERVER_DEFAULT_LOCALE);
}

export type { ServerMessageKey };
