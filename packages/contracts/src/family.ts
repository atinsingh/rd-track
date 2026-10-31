import { z } from 'zod';
import { uuid } from './events';

/**
 * Family (docs/design/08-family-plan.md): transparent parental controls built on Track.
 *
 * A family is an organization with `kind = 'family'`. Parents are `org_admin`. Each child is a
 * user with `org_role = 'child'`: no sign-in, an address no email is ever sent to, and a
 * `child_profiles` row (birth month, region). Devices connect to a child, so usage, retention
 * and erasure work as they do for employees.
 *
 * Family rules are their own document: a family default plus per-child overrides. Each field
 * of a child's document replaces the default's; anything neither sets falls back to
 * `FAMILY_RULE_DEFAULTS`. Devices get the resolved rules signed, like a policy.
 */

export const ORG_KINDS = ['business', 'family'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

/** Children above this many per family are refused (the family plan's ceiling). */
export const MAX_CHILDREN = 5;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
/** Minutes of screen time a day; null = no daily limit that day. */
const budget = z.int().min(0).max(1440).nullable();
/** An app as the platform names it: a macOS bundle id, a Windows .exe, an Android package. */
const appId = z.string().trim().min(1).max(200);
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain such as example.com');

export const ROUTINE_KINDS = ['bedtime', 'school', 'homework', 'custom'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/**
 * A routine: on these days between `start` and `end` (crossing midnight when end ≤ start),
 * only `allow_apps` may be used (and calls, which no rule ever blocks).
 */
export const routineSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  kind: z.enum(ROUTINE_KINDS),
  name: z.string().trim().min(1).max(60),
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7),
  start: hhmm,
  end: hhmm,
  allow_apps: z.array(appId).max(50).default([]),
});
export type Routine = z.infer<typeof routineSchema>;

export const familyRulesSchema = z.strictObject({
  /** Screen time a day across all devices. */
  daily_budget: z.strictObject(Object.fromEntries(WEEKDAYS.map((d) => [d, budget])) as Record<Weekday, typeof budget>),
  routines: z.array(routineSchema).max(10),
  /** Never allowed. */
  blocked_apps: z.array(appId).max(200),
  /** Minutes a day per app, within the daily budget. */
  app_limits: z.array(z.strictObject({ app: appId, minutes: z.int().min(0).max(1440) })).max(100),
  web: z.strictObject({
    /** Adult, gambling, malware and phishing sites (a family DNS resolver's categories). */
    block_adult: z.boolean(),
    /** Forces SafeSearch and YouTube Restricted Mode. */
    safe_search: z.boolean(),
    blocked_domains: z.array(hostname).max(500),
    /** Always allowed, even when a category would block them (school sites). */
    allowed_domains: z.array(hostname).max(500),
  }),
  /** Everything but calls is paused until then. */
  pause_until: z.iso.datetime({ offset: true }).nullable(),
  /** The child may ask for more time from their device. */
  allow_requests: z.boolean(),
});
export type FamilyRules = z.infer<typeof familyRulesSchema>;

/** A stored document: any subset of the top-level fields. */
export const partialFamilyRulesSchema = familyRulesSchema.partial();
export type PartialFamilyRules = z.infer<typeof partialFamilyRulesSchema>;
export const FAMILY_RULE_FIELDS = Object.keys(familyRulesSchema.shape) as (keyof FamilyRules)[];

/** What applies when neither the family nor the child sets a field: generous, safe web. */
export const FAMILY_RULE_DEFAULTS: FamilyRules = {
  daily_budget: { mon: 120, tue: 120, wed: 120, thu: 120, fri: 180, sat: 240, sun: 240 },
  routines: [{ id: 'bedtime', kind: 'bedtime', name: 'Bedtime', days: [...WEEKDAYS], start: '21:00', end: '07:00', allow_apps: [] }],
  blocked_apps: [],
  app_limits: [],
  web: { block_adult: true, safe_search: true, blocked_domains: [], allowed_domains: [] },
  pause_until: null,
  allow_requests: true,
};

export type RuleSource = 'child' | 'family' | 'default';

export interface ResolvedFamilyRules {
  rules: FamilyRules;
  /** Where each field came from. */
  sources: Record<keyof FamilyRules, RuleSource>;
}

/** The child's document wins field by field over the family's, which wins over the defaults. */
export function resolveFamilyRules(family: PartialFamilyRules | null, child: PartialFamilyRules | null): ResolvedFamilyRules {
  const rules = { ...FAMILY_RULE_DEFAULTS } as Record<keyof FamilyRules, unknown>;
  const sources = {} as Record<keyof FamilyRules, RuleSource>;
  for (const f of FAMILY_RULE_FIELDS) {
    if (child && child[f] !== undefined) {
      rules[f] = child[f];
      sources[f] = 'child';
    } else if (family && family[f] !== undefined) {
      rules[f] = family[f];
      sources[f] = 'family';
    } else sources[f] = 'default';
  }
  return { rules: rules as FamilyRules, sources };
}

// ───────────────────────── ages ─────────────────────────

/** Where the child lives, for the age at which they count as a teen (Québec: 14). */
export const FAMILY_REGIONS = ['CA', 'CA-QC', 'US', 'GB', 'EU', 'OTHER'] as const;
export type FamilyRegion = (typeof FAMILY_REGIONS)[number];

export function teenAge(region: FamilyRegion): number {
  return region === 'CA-QC' ? 14 : 13;
}

/** Whole years from the first of the birth month (the day is never asked for). */
export function ageOn(birthYear: number, birthMonth: number, on: Date): number {
  const y = on.getUTCFullYear() - birthYear;
  return on.getUTCMonth() + 1 >= birthMonth ? y : y - 1;
}

/** Children only: a profile is refused, and ends, at 18. */
export const ADULT_AGE = 18;

/** The first day of the month the child turns 18 (UTC), as YYYY-MM-DD. */
export function adultOn(birthYear: number, birthMonth: number): string {
  return `${birthYear + ADULT_AGE}-${String(birthMonth).padStart(2, '0')}-01`;
}

// ───────────────────────── wire ─────────────────────────

const birthYear = z.int().min(1900).max(2100);
const birthMonth = z.int().min(1).max(12);
export const CHILD_COLORS = ['amber', 'teal', 'rose', 'sky', 'lime', 'violet'] as const;

export const childCreate = z.strictObject({
  display_name: z.string().trim().min(1).max(60),
  birth_year: birthYear,
  birth_month: birthMonth,
  region: z.enum(FAMILY_REGIONS),
  color: z.enum(CHILD_COLORS).default('amber'),
});
/** Every field optional, and none defaulted (a PATCH never resets the colour). */
export const childUpdate = z
  .strictObject({
    display_name: z.string().trim().min(1).max(60),
    birth_year: birthYear,
    birth_month: birthMonth,
    region: z.enum(FAMILY_REGIONS),
    color: z.enum(CHILD_COLORS),
  })
  .partial();

/** Replaces a family's or a child's rule document (null fields are not allowed: omit them). */
export const familyRulesPut = z.strictObject({ rules: partialFamilyRulesSchema });

export const familySignupFields = z.strictObject({
  kind: z.enum(ORG_KINDS).default('business'),
});

export interface ChildDTO {
  id: string;
  display_name: string;
  birth_year: number;
  birth_month: number;
  region: FamilyRegion;
  color: (typeof CHILD_COLORS)[number];
  age: number;
  teen: boolean;
  /** YYYY-MM-DD: the profile ends then. */
  adult_on: string;
  devices: number;
  created_at: string;
}

export interface FamilyRulesDTO {
  /** null for the family's own document. */
  child_id: string | null;
  /** What this document sets (the editor's state). */
  document: PartialFamilyRules;
  /** The result for the child (for the family document: what a child with no overrides gets). */
  resolved: FamilyRules;
  sources: Record<keyof FamilyRules, RuleSource>;
  revision: number;
  updated_at: string | null;
}

export interface ChildTodayDTO {
  child_id: string;
  /** The child's local date, YYYY-MM-DD. */
  date: string;
  /** Screen time so far today, in minutes, across their devices. */
  used_minutes: number;
  /** Today's budget; null = no limit today. */
  budget_minutes: number | null;
  /** Most used apps today. */
  apps: { name: string; minutes: number }[];
  /** The routine in force now, if any. */
  routine_now: { name: string; until: string } | null;
  paused_until: string | null;
  devices: { id: string; name: string; os: string; last_seen_at: string | null; online: boolean }[];
}

/** What the child's own app shows ("what my parent can see"), worded for their age. */
export interface ChildTransparencyDTO {
  child_id: string;
  teen: boolean;
  /** Plain statements, in the reader's language. */
  can_see: string[];
  never_sees: string[];
  rules: FamilyRules;
}

/** The signed payload of `GET /v1/device/family-rules` (decoded from `payload_b64`). */
export interface SignedFamilyRulesPayload {
  organization_id: string;
  child_id: string;
  device_id: string;
  revision: number;
  issued_at: string;
  rules: FamilyRules;
}

/** `GET /v1/device/family-rules`: signed like the device policy (same key, same envelope). */
export interface FamilyRulesResponse {
  payload_b64: string;
  signature_b64: string;
  key_id: string;
}

export const childIdParam = z.object({ id: uuid });
