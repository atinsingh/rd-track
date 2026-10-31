import {
  FAMILY_RULE_FIELDS,
  WEEKDAYS,
  formatDuration,
  type FamilyRules,
  type PartialFamilyRules,
  type Routine,
  type Weekday,
} from '@rd/contracts';
import { addDays, todayInTz, zonedTimeToMs } from './time';

/** Family app helpers (doc 08): pure, so the editor's rules are testable. */

/** "1h 30m" for a number of minutes; "0m" for none. */
export function minutesLabel(minutes: number): string {
  return formatDuration(Math.max(0, Math.round(minutes)) * 60);
}

export interface BudgetState {
  /** 0–100, for the meter (capped). */
  pct: number;
  over: boolean;
  /** Minutes left today (0 when over), or null without a limit. */
  left: number | null;
}

export function budgetState(used: number, budget: number | null): BudgetState {
  if (budget === null) return { pct: 0, over: false, left: null };
  if (budget === 0) return { pct: 100, over: used > 0, left: 0 };
  return { pct: Math.min(100, Math.round((used / budget) * 100)), over: used > budget, left: Math.max(0, budget - used) };
}

/** A routine that ends at or before it starts runs past midnight ("21:00–07:00"). */
export function crossesMidnight(r: Pick<Routine, 'start' | 'end'>): boolean {
  return r.end <= r.start;
}

/** ISO 1 = Monday, as `weekdayShort` takes it. */
export function isoDay(d: Weekday): number {
  return WEEKDAYS.indexOf(d) + 1;
}

/** A fresh id for a new routine, unique among `taken`. */
export function routineId(kind: string, taken: readonly string[]): string {
  const base = kind.replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'routine';
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

// ───────────── the editor: inherit or override, field by field ─────────────

export type RuleField = keyof FamilyRules;

/** The value in force for `field`: the document's own, else the base it inherits. */
export function effective<F extends RuleField>(doc: PartialFamilyRules, base: FamilyRules, field: F): FamilyRules[F] {
  return (doc[field] as FamilyRules[F] | undefined) ?? base[field];
}

/** Whether this document sets `field` itself. */
export function sets(doc: PartialFamilyRules, field: RuleField): boolean {
  return doc[field] !== undefined;
}

/** The document with `field` set to `value` (a copy). */
export function override<F extends RuleField>(doc: PartialFamilyRules, field: F, value: FamilyRules[F]): PartialFamilyRules {
  return { ...doc, [field]: value };
}

/** The document without `field`, so it follows the base again (a copy). */
export function inherit(doc: PartialFamilyRules, field: RuleField): PartialFamilyRules {
  const next = { ...doc };
  delete next[field];
  return next;
}

/** The whole rule set in force. */
export function resolvedOf(doc: PartialFamilyRules, base: FamilyRules): FamilyRules {
  const out = { ...base } as Record<RuleField, unknown>;
  for (const f of FAMILY_RULE_FIELDS) if (doc[f] !== undefined) out[f] = doc[f];
  return out as FamilyRules;
}

/** Same rules, whatever the key order (for "unsaved changes"). */
export function sameDoc(a: PartialFamilyRules, b: PartialFamilyRules): boolean {
  const norm = (d: PartialFamilyRules) => JSON.stringify(FAMILY_RULE_FIELDS.filter((f) => d[f] !== undefined).map((f) => [f, d[f]]));
  return norm(a) === norm(b);
}

// ───────────── lists typed as text ─────────────

/** One entry per line or comma, trimmed, without blanks or repeats. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const v = part.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

/** A domain as people paste it ("https://www.Example.com/path") reduced to "example.com"; null if it isn't one. */
export function normalizeDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/^www\./, '');
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) ? v : null;
}

// ───────────── pausing ─────────────

/** An hour from now. */
export function pauseForAnHour(now: number = Date.now()): string {
  return new Date(now + 3600_000).toISOString();
}

/** 07:00 tomorrow in `tz`. */
export function pauseUntilMorning(tz: string, now: number = Date.now()): string {
  return new Date(zonedTimeToMs(addDays(todayInTz(tz, now), 1), '07:00', tz)).toISOString();
}

/** Whether a pause is still on. */
export function pausedNow(until: string | null, now: number = Date.now()): boolean {
  return !!until && Date.parse(until) > now;
}

// ───────────── profiles ─────────────

/** Years a parent can pick for a child's birth year: the last 18, newest first. */
export function birthYears(now: Date = new Date()): number[] {
  const y = now.getUTCFullYear();
  return Array.from({ length: 19 }, (_, i) => y - i);
}

export const CHILD_COLOR_HEX: Record<string, string> = {
  amber: '#C26A00',
  teal: '#0E7490',
  rose: '#BE185D',
  sky: '#0369A1',
  lime: '#4D7C0F',
  violet: '#6D28D9',
};
