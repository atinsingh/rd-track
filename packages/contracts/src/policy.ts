import { z } from 'zod';

/**
 * Collection policy model (system design §6.4, ADR-0003).
 *
 * Every scope (organization, team, project, device) stores a *partial* settings
 * document. `resolvePolicy` folds the applicable scopes into one effective
 * `PolicySettings` using a per-field strategy, and records which scopes decided
 * each field so the UI can explain "because Team Support sets 14 days".
 */

export const SCOPE_TYPES = ['organization', 'team', 'project', 'device'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
/** Resolver scopes also include the subscription plan, which only ever restricts. */
export type ResolverScopeType = ScopeType | 'plan';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const workHoursSchema = z.strictObject({
  timezone: z.string().min(1).max(64),
  /** ISO weekdays, 1 = Monday … 7 = Sunday */
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: hhmm,
  end: hhmm,
});
export type WorkHours = z.infer<typeof workHoursSchema>;

export const policySettingsSchema = z.strictObject({
  session: z.strictObject({
    allow_overlapping_sessions: z.boolean(),
    require_project: z.boolean(),
  }),
  idle: z.strictObject({
    threshold_seconds: z.number().int().min(60).max(1800),
    /** Ask the person what to do with an idle run when they come back (else: keep it). */
    prompt_on_return: z.boolean(),
  }),
  apps: z.strictObject({
    capture_app_name: z.boolean(),
    capture_domains: z.boolean(),
    capture_window_titles: z.boolean(),
  }),
  screenshots: z.strictObject({
    enabled: z.boolean(),
    interval_minutes: z.number().int().min(10).max(60),
    primary_monitor_only: z.boolean(),
    max_width_px: z.number().int().min(640).max(1920),
    excluded_apps: z.array(z.string().min(1).max(200)).max(200),
    employee_deletion: z.enum(['self_service', 'review']),
  }),
  viewers: z.strictObject({
    manager_can_view_activity: z.boolean(),
    manager_can_view_apps: z.boolean(),
    manager_can_view_screenshots: z.boolean(),
  }),
  work_hours: workHoursSchema.nullable(),
  retention: z.strictObject({
    screenshot_days: z.number().int().min(1).max(90),
    activity_days: z.number().int().min(7).max(365),
    app_usage_days: z.number().int().min(7).max(365),
  }),
  offline: z.strictObject({
    max_screenshot_buffer_mb: z.number().int().min(0).max(500),
    metadata_buffer_days: z.number().int().min(1).max(30),
  }),
});
export type PolicySettings = z.infer<typeof policySettingsSchema>;

/** A scope's stored document: any subset of fields; `work_hours` may only be set, not cleared. */
export const partialPolicySettingsSchema = z.strictObject({
  session: policySettingsSchema.shape.session.partial().optional(),
  idle: policySettingsSchema.shape.idle.partial().optional(),
  apps: policySettingsSchema.shape.apps.partial().optional(),
  screenshots: policySettingsSchema.shape.screenshots.partial().optional(),
  viewers: policySettingsSchema.shape.viewers.partial().optional(),
  work_hours: workHoursSchema.optional(),
  retention: policySettingsSchema.shape.retention.partial().optional(),
  offline: policySettingsSchema.shape.offline.partial().optional(),
});
export type PartialPolicySettings = z.infer<typeof partialPolicySettingsSchema>;

export const DEFAULT_POLICY: PolicySettings = {
  session: { allow_overlapping_sessions: false, require_project: false },
  idle: { threshold_seconds: 300, prompt_on_return: true },
  apps: { capture_app_name: true, capture_domains: false, capture_window_titles: false },
  screenshots: {
    enabled: false,
    interval_minutes: 15,
    primary_monitor_only: true,
    max_width_px: 1280,
    excluded_apps: [],
    employee_deletion: 'self_service',
  },
  viewers: {
    manager_can_view_activity: true,
    manager_can_view_apps: true,
    manager_can_view_screenshots: false,
  },
  work_hours: null,
  retention: { screenshot_days: 30, activity_days: 90, app_usage_days: 90 },
  offline: { max_screenshot_buffer_mb: 50, metadata_buffer_days: 7 },
};

type Strategy =
  /** any explicit false → false; else any explicit true → true; else default */
  | 'restrictive_bool'
  /** any explicit true → true; else any explicit false → false; else default */
  | 'any_true'
  | 'max'
  | 'min'
  | 'union'
  /** most specific scope that sets it; ties within a level resolved by `tie` */
  | 'specific';

interface FieldRule {
  path: readonly [keyof PolicySettings, string?];
  strategy: Strategy;
  tie?: 'max' | 'min';
  /** for enum fields under 'any_true'-like semantics: values in preference order */
  prefer?: readonly string[];
}

/** One rule per leaf. The order is the order fields are shown in admin UIs. */
export const POLICY_FIELD_RULES: readonly FieldRule[] = [
  { path: ['screenshots', 'enabled'], strategy: 'restrictive_bool' },
  { path: ['screenshots', 'interval_minutes'], strategy: 'max' },
  { path: ['screenshots', 'primary_monitor_only'], strategy: 'any_true' },
  { path: ['screenshots', 'max_width_px'], strategy: 'min' },
  { path: ['screenshots', 'excluded_apps'], strategy: 'union' },
  { path: ['screenshots', 'employee_deletion'], strategy: 'specific', prefer: ['self_service', 'review'] },
  { path: ['viewers', 'manager_can_view_activity'], strategy: 'restrictive_bool' },
  { path: ['viewers', 'manager_can_view_apps'], strategy: 'restrictive_bool' },
  { path: ['viewers', 'manager_can_view_screenshots'], strategy: 'restrictive_bool' },
  { path: ['apps', 'capture_app_name'], strategy: 'restrictive_bool' },
  { path: ['apps', 'capture_domains'], strategy: 'restrictive_bool' },
  { path: ['apps', 'capture_window_titles'], strategy: 'restrictive_bool' },
  { path: ['idle', 'threshold_seconds'], strategy: 'specific', tie: 'max' },
  { path: ['idle', 'prompt_on_return'], strategy: 'specific' },
  { path: ['session', 'allow_overlapping_sessions'], strategy: 'restrictive_bool' },
  { path: ['session', 'require_project'], strategy: 'any_true' },
  { path: ['work_hours'], strategy: 'specific' },
  { path: ['retention', 'screenshot_days'], strategy: 'min' },
  { path: ['retention', 'activity_days'], strategy: 'min' },
  { path: ['retention', 'app_usage_days'], strategy: 'min' },
  { path: ['offline', 'max_screenshot_buffer_mb'], strategy: 'min' },
  { path: ['offline', 'metadata_buffer_days'], strategy: 'specific', tie: 'min' },
];

export function fieldKey(rule: FieldRule): string {
  return rule.path[1] ? `${rule.path[0]}.${rule.path[1]}` : rule.path[0];
}

export interface PolicyScopeInput {
  scope_type: ResolverScopeType;
  scope_id: string;
  /** Display name, used only in explanations. */
  name?: string;
  settings: PartialPolicySettings;
}

export interface FieldSource {
  scope_type: ResolverScopeType;
  scope_id: string;
  name?: string;
}

export interface ResolvedPolicy {
  settings: PolicySettings;
  /** For each field key, the scopes whose explicit value produced the result (empty = default). */
  sources: Record<string, FieldSource[]>;
}

const SPECIFICITY: Record<ResolverScopeType, number> = { plan: -1, organization: 0, team: 1, project: 2, device: 3 };

function read(settings: PartialPolicySettings, rule: FieldRule): unknown {
  const [group, leaf] = rule.path;
  const g = (settings as Record<string, unknown>)[group];
  if (leaf === undefined) return g;
  if (g === undefined || g === null || typeof g !== 'object') return undefined;
  return (g as Record<string, unknown>)[leaf];
}

function write(target: PolicySettings, rule: FieldRule, value: unknown): void {
  const [group, leaf] = rule.path;
  if (leaf === undefined) {
    (target as Record<string, unknown>)[group] = value;
  } else {
    ((target as Record<string, unknown>)[group] as Record<string, unknown>)[leaf] = value;
  }
}

/** Policy settings are plain JSON, so a JSON round-trip is a complete deep copy. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Resolve the effective policy from the applicable scopes. Scope order does not
 * matter; specificity comes from `scope_type`.
 */
export function resolvePolicy(scopes: readonly PolicyScopeInput[]): ResolvedPolicy {
  const settings = clone(DEFAULT_POLICY);
  const sources: Record<string, FieldSource[]> = {};

  for (const rule of POLICY_FIELD_RULES) {
    const key = fieldKey(rule);
    const explicit = scopes
      .map((s) => ({ scope: s, value: read(s.settings, rule) }))
      .filter((e) => e.value !== undefined);
    const src = (es: typeof explicit) =>
      es.map(({ scope }) => ({ scope_type: scope.scope_type, scope_id: scope.scope_id, name: scope.name }));

    if (explicit.length === 0) {
      sources[key] = [];
      continue;
    }

    let value: unknown;
    let deciding: typeof explicit = [];
    switch (rule.strategy) {
      case 'restrictive_bool':
      case 'any_true': {
        const winner = rule.strategy === 'restrictive_bool' ? false : true;
        const hits = explicit.filter((e) => e.value === winner);
        deciding = hits.length > 0 ? hits : explicit;
        value = hits.length > 0 ? winner : !winner;
        break;
      }
      case 'max':
      case 'min': {
        const nums = explicit.map((e) => e.value as number);
        value = rule.strategy === 'max' ? Math.max(...nums) : Math.min(...nums);
        deciding = explicit.filter((e) => e.value === value);
        break;
      }
      case 'union': {
        const all = new Set<string>();
        for (const e of explicit) for (const v of e.value as string[]) all.add(v);
        value = [...all].sort();
        deciding = explicit;
        break;
      }
      case 'specific': {
        const top = Math.max(...explicit.map((e) => SPECIFICITY[e.scope.scope_type]));
        const level = explicit.filter((e) => SPECIFICITY[e.scope.scope_type] === top);
        if (rule.prefer) {
          const ranked = [...level].sort(
            (a, b) => rule.prefer!.indexOf(a.value as string) - rule.prefer!.indexOf(b.value as string),
          );
          value = ranked[0]!.value;
        } else if (rule.tie && level.length > 1) {
          const nums = level.map((e) => e.value as number);
          value = rule.tie === 'max' ? Math.max(...nums) : Math.min(...nums);
        } else {
          value = level[0]!.value;
        }
        deciding = level.filter((e) => sameValue(e.value, value));
        break;
      }
    }
    write(settings, rule, clone(value));
    sources[key] = src(deciding);
  }

  return { settings: policySettingsSchema.parse(settings), sources };
}

export interface CollectionChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Changes from `prev` to `next` that collect more about an employee or widen who
 * can see it (`POL-05`). An empty list means the change is neutral or restrictive.
 */
export function collectionExpansions(prev: PolicySettings, next: PolicySettings): CollectionChange[] {
  const out: CollectionChange[] = [];
  const add = (field: string, from: unknown, to: unknown) => out.push({ field, from, to });
  const turnedOn = (field: string, a: boolean, b: boolean) => {
    if (!a && b) add(field, a, b);
  };

  turnedOn('apps.capture_app_name', prev.apps.capture_app_name, next.apps.capture_app_name);
  turnedOn('apps.capture_domains', prev.apps.capture_domains, next.apps.capture_domains);
  turnedOn('apps.capture_window_titles', prev.apps.capture_window_titles, next.apps.capture_window_titles);
  turnedOn('screenshots.enabled', prev.screenshots.enabled, next.screenshots.enabled);
  turnedOn(
    'viewers.manager_can_view_activity',
    prev.viewers.manager_can_view_activity,
    next.viewers.manager_can_view_activity,
  );
  turnedOn('viewers.manager_can_view_apps', prev.viewers.manager_can_view_apps, next.viewers.manager_can_view_apps);
  turnedOn(
    'viewers.manager_can_view_screenshots',
    prev.viewers.manager_can_view_screenshots,
    next.viewers.manager_can_view_screenshots,
  );

  if (next.screenshots.enabled) {
    const p = prev.screenshots;
    const n = next.screenshots;
    if (p.enabled && n.interval_minutes < p.interval_minutes)
      add('screenshots.interval_minutes', p.interval_minutes, n.interval_minutes);
    if (p.enabled && n.max_width_px > p.max_width_px) add('screenshots.max_width_px', p.max_width_px, n.max_width_px);
    if (p.primary_monitor_only && !n.primary_monitor_only)
      add('screenshots.primary_monitor_only', p.primary_monitor_only, n.primary_monitor_only);
    const removed = p.excluded_apps.filter((a) => !n.excluded_apps.includes(a));
    if (removed.length > 0) add('screenshots.excluded_apps', p.excluded_apps, n.excluded_apps);
    if (p.employee_deletion === 'self_service' && n.employee_deletion === 'review')
      add('screenshots.employee_deletion', p.employee_deletion, n.employee_deletion);
    if (p.enabled && next.retention.screenshot_days > prev.retention.screenshot_days)
      add('retention.screenshot_days', prev.retention.screenshot_days, next.retention.screenshot_days);
  }
  if (next.retention.activity_days > prev.retention.activity_days)
    add('retention.activity_days', prev.retention.activity_days, next.retention.activity_days);
  if (next.retention.app_usage_days > prev.retention.app_usage_days)
    add('retention.app_usage_days', prev.retention.app_usage_days, next.retention.app_usage_days);
  if (prev.work_hours !== null && next.work_hours === null) add('work_hours', prev.work_hours, null);
  return out;
}
