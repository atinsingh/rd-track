import {
  POLICY_FIELD_RULES,
  fieldKey,
  partialPolicySettingsSchema,
  type CollectionChange,
  type FieldSource,
  type PartialPolicySettings,
  type PolicySettings,
  type ScopeType,
  type WorkHours,
} from '@rd/contracts';
import { t, type MessageKey } from './i18n';
import { weekdayShort } from './time';

/**
 * Policy editor model: converts a scope's partial settings document to per-field
 * form inputs (Not set / value) and back (UX §3.6).
 */

export type FieldKind = 'bool' | 'number' | 'enum' | 'list' | 'work_hours';

export interface FieldMeta {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: FieldKind;
  unit?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

const META: Record<string, Omit<FieldMeta, 'key'>> = {
  'screenshots.enabled': {
    group: 'Screenshots',
    label: 'Screenshots',
    help: 'Off unless a scope turns it on; any scope can turn it off',
    kind: 'bool',
  },
  'screenshots.interval_minutes': {
    group: 'Screenshots',
    label: 'Screenshot interval',
    help: 'One random capture per interval; the longest wins',
    kind: 'number',
    unit: 'min',
    min: 10,
    max: 60,
  },
  'screenshots.primary_monitor_only': {
    group: 'Screenshots',
    label: 'Primary monitor only',
    help: 'Any scope can require it',
    kind: 'bool',
  },
  'screenshots.max_width_px': {
    group: 'Screenshots',
    label: 'Screenshot width limit',
    help: 'Images are reduced to this width; the smallest wins',
    kind: 'number',
    unit: 'px',
    min: 640,
    max: 1920,
  },
  'screenshots.excluded_apps': {
    group: 'Screenshots',
    label: 'Apps never captured',
    help: 'One app name per line; lists from all scopes are combined',
    kind: 'list',
  },
  'screenshots.employee_deletion': {
    group: 'Screenshots',
    label: 'Employee deletion requests',
    help: 'Self-service wins over review',
    kind: 'enum',
    options: [
      { value: 'self_service', label: 'Self-service' },
      { value: 'review', label: 'Admin review' },
    ],
  },
  'viewers.manager_can_view_activity': {
    group: 'Who can see it',
    label: 'Managers can view computer activity',
    help: 'Team managers see activity summaries for their members',
    kind: 'bool',
  },
  'viewers.manager_can_view_apps': {
    group: 'Who can see it',
    label: 'Managers can view app names',
    help: 'Time per application in front',
    kind: 'bool',
  },
  'viewers.manager_can_view_screenshots': {
    group: 'Who can see it',
    label: 'Managers can view screenshots',
    help: 'Org admins never see screenshots by default; every view is recorded',
    kind: 'bool',
  },
  'apps.capture_app_name': {
    group: 'Applications',
    label: 'Application names',
    help: 'Name of the app in front',
    kind: 'bool',
  },
  'apps.capture_domains': {
    group: 'Applications',
    label: 'Website domains',
    help: 'Domain only; needs the approved browser integration',
    kind: 'bool',
  },
  'apps.capture_window_titles': {
    group: 'Applications',
    label: 'Window titles and full URLs',
    help: 'Not collected in this release',
    kind: 'bool',
  },
  'idle.threshold_seconds': {
    group: 'Sessions',
    label: 'Idle after',
    help: 'No input for this long counts as idle; the most specific scope wins',
    kind: 'number',
    unit: 's',
    min: 60,
    max: 1800,
  },
  'idle.prompt_on_return': {
    group: 'Sessions',
    label: 'Ask on return from idle',
    help: 'The agent asks whether to keep, remove or move idle time. Off: idle time is kept without asking',
    kind: 'bool',
  },
  'session.allow_overlapping_sessions': {
    group: 'Sessions',
    label: 'Allow overlapping sessions',
    help: 'Any scope can forbid it',
    kind: 'bool',
  },
  'session.require_project': {
    group: 'Sessions',
    label: 'Require a project',
    help: 'Any scope can require it',
    kind: 'bool',
  },
  work_hours: {
    group: 'Sessions',
    label: 'Work hours',
    help: 'Collection pauses outside this window; the most specific scope wins. Once set it can be changed but not removed.',
    kind: 'work_hours',
  },
  'retention.screenshot_days': {
    group: 'Retention',
    label: 'Screenshot retention',
    help: 'The shortest wins',
    kind: 'number',
    unit: 'days',
    min: 1,
    max: 90,
  },
  'retention.activity_days': {
    group: 'Retention',
    label: 'Activity retention',
    help: 'Minute-by-minute activity; the shortest wins',
    kind: 'number',
    unit: 'days',
    min: 7,
    max: 365,
  },
  'retention.app_usage_days': {
    group: 'Retention',
    label: 'App usage retention',
    help: 'The shortest wins',
    kind: 'number',
    unit: 'days',
    min: 7,
    max: 365,
  },
  'offline.max_screenshot_buffer_mb': {
    group: 'Offline',
    label: 'Offline screenshot buffer',
    help: 'The smallest wins',
    kind: 'number',
    unit: 'MB',
    min: 0,
    max: 500,
  },
  'offline.metadata_buffer_days': {
    group: 'Offline',
    label: 'Offline metadata buffer',
    help: 'How long the agent keeps unsent records; the most specific scope wins',
    kind: 'number',
    unit: 'days',
    min: 1,
    max: 30,
  },
};

/** Group names as written above → their catalogue ids. */
const GROUP_ID: Record<string, string> = {
  Screenshots: 'screenshots',
  'Who can see it': 'viewers',
  Applications: 'apps',
  Sessions: 'sessions',
  Retention: 'retention',
  Offline: 'offline',
  Other: 'other',
};

/** A unit ("days") in the reader's language; symbols ("min", "px") stay. */
export const unitLabel = (unit: string | undefined): string | undefined =>
  unit === 'days' ? t('adm.pf.unit.days') : unit;

/**
 * Labels, help and option names are read in the current language each time (G27); the
 * English above is the source (the catalogue repeats it word for word).
 */
function localized(key: string, m: Omit<FieldMeta, 'key'>): FieldMeta {
  const known = key in META;
  const tk = (part: string) => `adm.pf.${key}.${part}` as MessageKey;
  return {
    key,
    kind: m.kind,
    min: m.min,
    max: m.max,
    get unit() {
      return unitLabel(m.unit);
    },
    get group() {
      return t(`adm.pf.group.${GROUP_ID[m.group] ?? 'other'}` as MessageKey);
    },
    get label() {
      return known ? t(tk('label')) : m.label;
    },
    get help() {
      return known ? t(tk('help')) : m.help;
    },
    get options() {
      return m.options?.map((o) => ({ value: o.value, label: t(`adm.pf.${key}.opt.${o.value}` as MessageKey) }));
    },
  };
}

export const POLICY_FIELDS: FieldMeta[] = POLICY_FIELD_RULES.map((r) => {
  const key = fieldKey(r);
  return localized(key, META[key] ?? { group: 'Other', label: key, help: '', kind: 'bool' as FieldKind });
});

export function fieldMeta(key: string): FieldMeta {
  return POLICY_FIELDS.find((f) => f.key === key) ?? localized(key, { group: 'Other', label: key, help: '', kind: 'bool' });
}

export interface WorkHoursInput {
  timezone: string;
  days: number[];
  start: string;
  end: string;
}

/** Uniform input shape; each kind reads its own property. */
export interface FieldInput {
  set: boolean;
  bool: boolean;
  text: string;
  wh: WorkHoursInput;
}

export type PolicyForm = Record<string, FieldInput>;

const DEFAULT_WH: WorkHoursInput = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

function readPath(settings: unknown, key: string): unknown {
  let cur: unknown = settings;
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function readField(settings: PolicySettings | PartialPolicySettings | null | undefined, key: string): unknown {
  return readPath(settings, key);
}

export function formFromPartial(partial: PartialPolicySettings | null | undefined, defaultTz = 'UTC'): PolicyForm {
  const form: PolicyForm = {};
  for (const f of POLICY_FIELDS) {
    const v = readPath(partial ?? {}, f.key);
    const input: FieldInput = { set: v !== undefined, bool: false, text: '', wh: { ...DEFAULT_WH, timezone: defaultTz } };
    if (v !== undefined) {
      switch (f.kind) {
        case 'bool':
          input.bool = v === true;
          break;
        case 'number':
        case 'enum':
          input.text = String(v);
          break;
        case 'list':
          input.text = Array.isArray(v) ? v.join('\n') : '';
          break;
        case 'work_hours': {
          const wh = v as WorkHours;
          input.wh = { timezone: wh.timezone, days: [...wh.days], start: wh.start, end: wh.end };
          break;
        }
      }
    } else if (f.kind === 'enum') {
      input.text = f.options?.[0]?.value ?? '';
    }
    form[f.key] = input;
  }
  return form;
}

export interface FormConversion {
  settings: PartialPolicySettings;
  errors: Record<string, string>;
}

export function parseList(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/[\n,]/)) {
    const t = line.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Form → partial settings document. Unset fields and empty groups are omitted. */
export function partialFromForm(form: PolicyForm): FormConversion {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    const [group, leaf] = key.split('.') as [string, string | undefined];
    if (leaf === undefined) {
      out[group] = value;
      return;
    }
    const g = (out[group] as Record<string, unknown> | undefined) ?? {};
    g[leaf] = value;
    out[group] = g;
  };

  for (const f of POLICY_FIELDS) {
    const input = form[f.key];
    if (!input || !input.set) continue;
    switch (f.kind) {
      case 'bool':
        put(f.key, input.bool);
        break;
      case 'number': {
        const raw = input.text.trim();
        if (!/^-?\d+$/.test(raw)) {
          errors[f.key] = t('adm.pf.err.whole');
          break;
        }
        const n = Number(raw);
        if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          errors[f.key] = f.unit ? t('adm.pf.err.betweenUnit', { min: f.min ?? '', max: f.max ?? '', unit: f.unit }) : t('adm.pf.err.between', { min: f.min ?? '', max: f.max ?? '' });
          break;
        }
        put(f.key, n);
        break;
      }
      case 'enum':
        if (!f.options?.some((o) => o.value === input.text)) {
          errors[f.key] = t('adm.pf.err.option');
          break;
        }
        put(f.key, input.text);
        break;
      case 'list':
        put(f.key, parseList(input.text));
        break;
      case 'work_hours': {
        const wh = input.wh;
        if (wh.days.length === 0) {
          errors[f.key] = t('adm.pf.err.day');
          break;
        }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(wh.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(wh.end)) {
          errors[f.key] = t('adm.pf.err.time');
          break;
        }
        if (!wh.timezone.trim()) {
          errors[f.key] = t('adm.pf.err.tz');
          break;
        }
        put(f.key, {
          timezone: wh.timezone.trim(),
          days: [...new Set(wh.days)].sort((a, b) => a - b),
          start: wh.start,
          end: wh.end,
        });
        break;
      }
    }
  }

  const parsed = partialPolicySettingsSchema.safeParse(out);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.filter((p) => typeof p === 'string').join('.');
      const key = POLICY_FIELDS.find((f) => path === f.key || path.startsWith(`${f.key}.`))?.key ?? path;
      if (!errors[key]) errors[key] = issue.message;
    }
    return { settings: out as PartialPolicySettings, errors };
  }
  return { settings: parsed.data, errors };
}

export function sameSettings(a: PartialPolicySettings | null | undefined, b: PartialPolicySettings | null | undefined): boolean {
  return stableStringify(a ?? {}) === stableStringify(b ?? {});
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function formatDays(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] ?? 0) + 1);
  if (contiguous && sorted.length > 2) return `${weekdayShort(sorted[0] ?? 1)}–${weekdayShort(sorted[sorted.length - 1] ?? 1)}`;
  return sorted.map((d) => weekdayShort(d)).join(', ');
}

/** Human value for a field: "On", "15 min", "Self-service", "Mon–Fri 09:00–17:00 (Europe/London)". */
export function formatFieldValue(key: string, v: unknown): string {
  const f = fieldMeta(key);
  if (v === undefined) return t('adm.pf.notSet');
  if (f.kind === 'work_hours') {
    if (v === null) return t('adm.pf.noLimit');
    const wh = v as WorkHours;
    return `${formatDays(wh.days)} ${wh.start}–${wh.end} (${wh.timezone})`;
  }
  if (typeof v === 'boolean') return v ? t('adm.pf.on') : t('adm.pf.off');
  if (typeof v === 'number') {
    if (key === 'idle.threshold_seconds' && v % 60 === 0) return `${v / 60} min`;
    return f.unit ? `${v} ${f.unit}` : String(v);
  }
  if (Array.isArray(v)) return v.length ? v.join(', ') : t('adm.pf.none');
  if (typeof v === 'string') return f.options?.find((o) => o.value === v)?.label ?? v;
  if (v === null) return t('adm.pf.none');
  return JSON.stringify(v);
}

export function describeChange(c: CollectionChange): string {
  return `${fieldMeta(c.field).label}: ${formatFieldValue(c.field, c.from).toLowerCase()} → ${formatFieldValue(c.field, c.to).toLowerCase()}`;
}

/** "Team", "Project"…, in the reader's language. */
export const scopeLabel = (type: string): string =>
  ['organization', 'team', 'project', 'device'].includes(type) ? t(`adm.scope.${type}` as MessageKey) : type;

/** "because …" text for the effective value of a field. */
export function describeSources(
  sources: readonly FieldSource[] | undefined,
  current: { scope_type: ScopeType; scope_id: string },
): string {
  if (!sources || sources.length === 0) return t('adm.pf.src.default');
  const names = sources.map((s) => {
    if (s.scope_type === current.scope_type && s.scope_id === current.scope_id) return t('adm.pf.src.thisScope');
    if (s.scope_type === 'plan') return t('adm.pf.src.yourPlan');
    const label = scopeLabel(s.scope_type);
    return s.name ? t('adm.pf.src.named', { scope: label, name: s.name }) : label.toLowerCase();
  });
  const unique = [...new Set(names)];
  const text = unique.length > 1 ? t('adm.pf.src.and', { list: unique.slice(0, -1).join(', '), last: unique[unique.length - 1]! }) : unique[0]!;
  return t(unique.length > 1 ? 'adm.pf.src.because.other' : 'adm.pf.src.because.one', { who: text });
}

/** Per-field diff between the stored document and the edited one, for the publish review. */
export function diffPartials(
  before: PartialPolicySettings | null | undefined,
  after: PartialPolicySettings,
): { key: string; label: string; from: string; to: string }[] {
  const out: { key: string; label: string; from: string; to: string }[] = [];
  for (const f of POLICY_FIELDS) {
    const a = readPath(before ?? {}, f.key);
    const b = readPath(after, f.key);
    if (stableStringify(a ?? null) !== stableStringify(b ?? null) || (a === undefined) !== (b === undefined)) {
      out.push({ key: f.key, label: f.label, from: formatFieldValue(f.key, a), to: formatFieldValue(f.key, b) });
    }
  }
  return out;
}
