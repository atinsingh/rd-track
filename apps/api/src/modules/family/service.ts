import {
  ADULT_AGE,
  FAMILY_RULE_DEFAULTS,
  FAMILY_RULE_FIELDS,
  MAX_CHILDREN,
  WEEKDAYS,
  adultOn,
  ageOn,
  matchLocale,
  partialFamilyRulesSchema,
  resolveFamilyRules,
  teenAge,
  type ChildDTO,
  type ChildTodayDTO,
  type ChildTransparencyDTO,
  type FamilyRegion,
  type FamilyRules,
  type FamilyRulesDTO,
  type FamilyRulesResponse,
  type PartialFamilyRules,
  type Routine,
  type SignedFamilyRulesPayload,
  type Weekday,
  type childCreate,
  type childUpdate,
} from '@rd/contracts';
import type { z } from 'zod';
import type { DeviceActor, Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { childEmail } from '../../email/sender';
import { SERVER_DEFAULT_LOCALE, lang, localesOf, type Lang, type ServerMessageKey } from '../../i18n';
import { signEd25519 } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { erasePerson } from '../lifecycle/person';
import { endAccess } from '../org/service';

/**
 * Family (docs/design/08-family-plan.md, phase 1). A family is an organization of kind
 * 'family'; its org_admins are the parents; each child is a user with org_role 'child' (no
 * sign-in, never emailed) plus a child_profiles row. Rules: one family document and one per
 * child, resolved field by field (resolveFamilyRules), delivered signed to the child's devices.
 */

/** Heartbeats come every minute; a device seen within this window counts as on. */
export const ONLINE_WINDOW_MS = 5 * 60_000;

const notFamily = () => new AppError(403, 'not_family', 'This is only for families.');

/** The actor must be an admin (a parent) of a family organization. */
export async function assertFamily(q: Queryable, actor: UserActor): Promise<void> {
  const o = await one<{ kind: string }>(q, 'SELECT kind FROM organizations WHERE id = $1', [actor.organizationId]);
  if (o?.kind !== 'family') throw notFamily();
  if (actor.orgRole !== 'org_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
}

interface ChildRow {
  id: string;
  display_name: string;
  birth_year: number;
  birth_month: number;
  region: FamilyRegion;
  color: ChildDTO['color'];
  timezone: string;
  created_at: string;
  devices: number;
}

const CHILD_SELECT = `
  SELECT u.id, u.display_name, u.timezone, c.birth_year, c.birth_month, c.region, c.color, c.created_at,
         (SELECT count(*)::int FROM devices d WHERE d.user_id = u.id AND d.credential_status = 'active') AS devices
  FROM users u JOIN child_profiles c ON c.user_id = u.id
  WHERE u.organization_id = $1 AND u.org_role = 'child' AND u.status = 'active'`;

function toDTO(r: ChildRow, now: Date): ChildDTO {
  const age = ageOn(r.birth_year, r.birth_month, now);
  return {
    id: r.id,
    display_name: r.display_name,
    birth_year: r.birth_year,
    birth_month: r.birth_month,
    region: r.region,
    color: r.color,
    age,
    teen: age >= teenAge(r.region),
    adult_on: adultOn(r.birth_year, r.birth_month),
    devices: r.devices,
    created_at: new Date(r.created_at).toISOString(),
  };
}

async function childRow(q: Queryable, orgId: string, id: string): Promise<ChildRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw errors.notFound('Child');
  const r = await one<ChildRow>(q, `${CHILD_SELECT} AND u.id = $2`, [orgId, id]);
  if (!r) throw errors.notFound('Child');
  return r;
}

export async function listChildren(deps: Deps, q: Queryable, actor: UserActor): Promise<ChildDTO[]> {
  await assertFamily(q, actor);
  const rows = await many<ChildRow>(q, `${CHILD_SELECT} ORDER BY c.created_at, c.birth_year, c.birth_month, u.display_name`, [actor.organizationId]);
  return rows.map((r) => toDTO(r, deps.now()));
}

export async function getChild(deps: Deps, q: Queryable, actor: UserActor, id: string): Promise<ChildDTO> {
  await assertFamily(q, actor);
  return toDTO(await childRow(q, actor.organizationId, id), deps.now());
}

function assertMinor(birthYear: number, birthMonth: number, now: Date) {
  if (ageOn(birthYear, birthMonth, now) >= ADULT_AGE) throw new AppError(422, 'adult', 'RoundDigital Family is for children under 18.');
  if (ageOn(birthYear, birthMonth, now) < 0) throw errors.validation('That birth month is in the future.');
}

export async function createChild(deps: Deps, q: Queryable, actor: UserActor, input: z.infer<typeof childCreate>, requestId?: string): Promise<ChildDTO> {
  await assertFamily(q, actor);
  assertMinor(input.birth_year, input.birth_month, deps.now());
  const n = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM users WHERE organization_id = $1 AND org_role = 'child' AND status = 'active'`, [
    actor.organizationId,
  ]);
  if (n!.n >= MAX_CHILDREN) throw new AppError(409, 'family_full', `A family can have up to ${MAX_CHILDREN} children.`);
  const parent = await one<{ timezone: string; locale: string | null }>(q, 'SELECT timezone, locale FROM users WHERE id = $1', [actor.userId]);
  // The address is set from the id once it exists: a reserved domain that is never delivered to.
  const u = await one<{ id: string }>(
    q,
    `INSERT INTO users (organization_id, email, display_name, org_role, tracking_enabled, timezone, locale)
     VALUES ($1, 'pending-' || gen_random_uuid() || '@family.invalid', $2, 'child', true, $3, $4) RETURNING id`,
    [actor.organizationId, input.display_name, parent?.timezone ?? 'UTC', parent?.locale ?? null],
  );
  await q.query('UPDATE users SET email = $2 WHERE id = $1', [u!.id, childEmail(u!.id)]);
  await q.query(
    `INSERT INTO child_profiles (user_id, organization_id, birth_year, birth_month, region, color, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [u!.id, actor.organizationId, input.birth_year, input.birth_month, input.region, input.color, deps.now().toISOString()],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'family.child_created',
    targetType: 'user',
    targetId: u!.id,
    targetUserId: u!.id,
    requestId,
    metadata: { region: input.region },
  });
  return getChild(deps, q, actor, u!.id);
}

export async function updateChild(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  patch: z.infer<typeof childUpdate>,
  requestId?: string,
): Promise<ChildDTO> {
  await assertFamily(q, actor);
  const cur = await childRow(q, actor.organizationId, id);
  const year = patch.birth_year ?? cur.birth_year;
  const month = patch.birth_month ?? cur.birth_month;
  assertMinor(year, month, deps.now());
  if (patch.display_name !== undefined) await q.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, patch.display_name]);
  await q.query('UPDATE child_profiles SET birth_year = $2, birth_month = $3, region = $4, color = $5 WHERE user_id = $1', [
    id,
    year,
    month,
    patch.region ?? cur.region,
    patch.color ?? cur.color,
  ]);
  const fields = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'family.child_updated', targetType: 'user', targetId: id, targetUserId: id, requestId, metadata: { fields } });
  return getChild(deps, q, actor, id);
}

/**
 * Removes a child for good: their computers are disconnected and everything recorded about them
 * is erased now, through the same erasure as an employee's (run inline, not queued). Their
 * rules and profile go too; the account stays only as an anonymous "Erased person" row.
 */
export async function removeChild(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<{ removed: true }> {
  await assertFamily(q, actor);
  await childRow(q, actor.organizationId, id);
  await endAccess(deps, q, actor, id, requestId);
  const req = await one<{ id: string }>(
    q,
    `INSERT INTO erasure_requests (organization_id, user_id, reason, status, decided_by, decided_at) VALUES ($1, $2, $3, 'approved', $4, $5) RETURNING id`,
    [actor.organizationId, id, 'Child removed from the family', actor.userId, deps.now().toISOString()],
  );
  // The confirmation email it returns is for the child's reserved address: never sent.
  await erasePerson(deps, q, req!.id);
  // Unlike an employee's hours, a child's sessions are nobody's record: they go too.
  await q.query('DELETE FROM work_sessions WHERE user_id = $1', [id]);
  await q.query('DELETE FROM family_rules WHERE child_user_id = $1', [id]);
  await q.query('DELETE FROM child_profiles WHERE user_id = $1', [id]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'family.child_removed', targetType: 'user', targetId: id, targetUserId: id, requestId });
  return { removed: true };
}

// ───────────── rules ─────────────

async function documentOf(q: Queryable, orgId: string, childId: string | null): Promise<{ document: PartialFamilyRules; updated_at: string | null } | null> {
  const r = await one<{ document: PartialFamilyRules; updated_at: string }>(
    q,
    'SELECT document, updated_at FROM family_rules WHERE organization_id = $1 AND child_user_id IS NOT DISTINCT FROM $2',
    [orgId, childId],
  );
  return r ? { document: r.document, updated_at: new Date(r.updated_at).toISOString() } : null;
}

async function revisionOf(q: Queryable, orgId: string): Promise<number> {
  return (await one<{ policy_revision: number }>(q, 'SELECT policy_revision FROM organizations WHERE id = $1', [orgId]))!.policy_revision;
}

/** The rules that apply to a child now. */
export async function rulesForChild(q: Queryable, orgId: string, childId: string): Promise<ReturnType<typeof resolveFamilyRules>> {
  const family = await documentOf(q, orgId, null);
  const child = await documentOf(q, orgId, childId);
  return resolveFamilyRules(family?.document ?? null, child?.document ?? null);
}

async function rulesDTO(q: Queryable, orgId: string, childId: string | null, l?: Lang): Promise<FamilyRulesDTO> {
  const family = await documentOf(q, orgId, null);
  const own = childId ? await documentOf(q, orgId, childId) : family;
  const resolved = resolveFamilyRules(family?.document ?? null, childId ? (own?.document ?? null) : null);
  return {
    child_id: childId,
    document: own?.document ?? {},
    // Only the untouched built-in default is renamed; a stored document is the parent's words.
    resolved: l && resolved.sources.routines === 'default' ? localizeDefaults(resolved.rules, l) : resolved.rules,
    sources: resolved.sources,
    revision: await revisionOf(q, orgId),
    updated_at: own?.updated_at ?? null,
  };
}

export async function getRules(q: Queryable, actor: UserActor, childId: string | null, acceptLanguage?: string): Promise<FamilyRulesDTO> {
  await assertFamily(q, actor);
  if (childId) await childRow(q, actor.organizationId, childId);
  return rulesDTO(q, actor.organizationId, childId, await readerLang(q, actor.userId, acceptLanguage));
}

/** Replaces the family's or a child's document; devices refetch on their next heartbeat. */
export async function putRules(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  childId: string | null,
  rules: PartialFamilyRules,
  requestId?: string,
  acceptLanguage?: string,
): Promise<FamilyRulesDTO> {
  await assertFamily(q, actor);
  if (childId) await childRow(q, actor.organizationId, childId);
  const document = partialFamilyRulesSchema.parse(rules);
  const before = (await documentOf(q, actor.organizationId, childId))?.document ?? {};
  await q.query(
    `INSERT INTO family_rules (organization_id, child_user_id, document, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, child_user_id) DO UPDATE SET document = EXCLUDED.document, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [actor.organizationId, childId, JSON.stringify(document), deps.now().toISOString(), actor.userId],
  );
  await q.query('UPDATE organizations SET policy_revision = policy_revision + 1 WHERE id = $1', [actor.organizationId]);
  // Which fields changed, never their values (domains and apps say a lot about a child).
  const changed = FAMILY_RULE_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(document[f]));
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'family.rules_changed',
    targetType: childId ? 'user' : 'organization',
    targetId: childId ?? actor.organizationId,
    targetUserId: childId ?? undefined,
    requestId,
    metadata: { fields: changed, scope: childId ? 'child' : 'family' },
  });
  return rulesDTO(q, actor.organizationId, childId, await readerLang(q, actor.userId, acceptLanguage));
}

// ───────────── today ─────────────

/** The local calendar parts of `at` in `tz`. */
function localParts(at: Date, tz: string): { date: string; weekday: Weekday; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: String(parts.weekday).toLowerCase().slice(0, 3) as Weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** The UTC instant of local `date` + `minutes` in `tz` (the offset at that moment). */
function instantOf(date: string, minutes: number, tz: string): Date {
  const guess = new Date(`${date}T00:00:00Z`).getTime() + minutes * 60_000;
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), tz);
    const shownMs = new Date(`${p.date}T00:00:00Z`).getTime() + p.minutes * 60_000;
    t += guess - shownMs;
  }
  return new Date(t);
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const prevDay = (d: Weekday): Weekday => WEEKDAYS[(WEEKDAYS.indexOf(d) + 6) % 7]!;
const addDays = (date: string, n: number) => new Date(new Date(`${date}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** The routine in force at local `weekday`/`minutes`, and when it ends (local date + minutes). */
export function routineAt(routines: readonly Routine[], date: string, weekday: Weekday, minutes: number): { routine: Routine; endDate: string; endMinutes: number } | null {
  for (const r of routines) {
    const start = toMin(r.start);
    const end = toMin(r.end);
    if (end > start) {
      if (r.days.includes(weekday) && minutes >= start && minutes < end) return { routine: r, endDate: date, endMinutes: end };
    } else {
      // Crosses midnight: from start today, or until end if it started yesterday.
      if (r.days.includes(weekday) && minutes >= start) return { routine: r, endDate: addDays(date, 1), endMinutes: end };
      if (r.days.includes(prevDay(weekday)) && minutes < end) return { routine: r, endDate: date, endMinutes: end };
    }
  }
  return null;
}

export async function childToday(deps: Deps, q: Queryable, actor: UserActor, id: string): Promise<ChildTodayDTO> {
  await assertFamily(q, actor);
  const child = await childRow(q, actor.organizationId, id);
  const now = deps.now();
  const tz = child.timezone || 'UTC';
  const local = localParts(now, tz);
  const from = instantOf(local.date, 0, tz);
  const to = instantOf(addDays(local.date, 1), 0, tz);
  const apps = await many<{ name: string; seconds: number }>(
    q,
    `SELECT app_name AS name, sum(duration_seconds)::int AS seconds FROM app_usage
     WHERE organization_id = $1 AND user_id = $2 AND started_at >= $3 AND started_at < $4
     GROUP BY app_name ORDER BY seconds DESC`,
    [actor.organizationId, id, from.toISOString(), to.toISOString()],
  );
  const total = apps.reduce((s, a) => s + a.seconds, 0);
  const { rules } = await rulesForChild(q, actor.organizationId, id);
  const r = routineAt(rules.routines, local.date, local.weekday, local.minutes);
  const devices = await many<{ id: string; name: string; os: string; last_seen_at: string | null }>(
    q,
    `SELECT id, name, os, last_seen_at FROM devices WHERE user_id = $1 AND credential_status = 'active' ORDER BY enrolled_at`,
    [id],
  );
  const paused = rules.pause_until && new Date(rules.pause_until).getTime() > now.getTime() ? rules.pause_until : null;
  return {
    child_id: id,
    date: local.date,
    used_minutes: Math.round(total / 60),
    budget_minutes: rules.daily_budget[local.weekday],
    apps: apps.slice(0, 8).map((a) => ({ name: a.name, minutes: Math.round(a.seconds / 60) })),
    routine_now: r ? { name: r.routine.name, until: instantOf(r.endDate, r.endMinutes, tz).toISOString() } : null,
    paused_until: paused,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      os: d.os,
      last_seen_at: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
      online: Boolean(d.last_seen_at && now.getTime() - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS),
    })),
  };
}

// ───────────── what the child is told ─────────────

/** The reader's language: their own or their family's choice, else their browser's, else English. */
async function readerLang(q: Queryable, userId: string, acceptLanguage?: string): Promise<Lang> {
  const chosen = (await localesOf(q, [userId], { withoutDefault: true })).get(userId);
  if (chosen) return lang(chosen);
  const preferred = (acceptLanguage ?? '')
    .split(',')
    .map((p) => p.split(';')[0]!.trim())
    .filter(Boolean);
  return lang(matchLocale(preferred) ?? SERVER_DEFAULT_LOCALE);
}

/** The built-in bedtime routine, untouched, is named in the reader's language. */
function localizeDefaults(rules: FamilyRules, l: Lang): FamilyRules {
  const builtIn = FAMILY_RULE_DEFAULTS.routines[0]!;
  return {
    ...rules,
    routines: rules.routines.map((r) => (JSON.stringify(r) === JSON.stringify(builtIn) ? { ...r, name: l.t('family.routine.bedtime') } : r)),
  };
}

export async function transparency(deps: Deps, q: Queryable, actor: UserActor, id: string, acceptLanguage?: string): Promise<ChildTransparencyDTO> {
  await assertFamily(q, actor);
  const child = toDTO(await childRow(q, actor.organizationId, id), deps.now());
  // In the reader's language: the parent previewing it now, the child's own app later.
  const l = await readerLang(q, actor.userId, acceptLanguage);
  const { rules } = await rulesForChild(q, actor.organizationId, id);
  const see: ServerMessageKey[] = [
    child.teen ? 'family.see.apps.teen' : 'family.see.apps',
    'family.see.budget',
    'family.see.rules',
    'family.see.devices',
    ...(rules.allow_requests ? (['family.see.requests'] as const) : []),
    child.teen ? 'family.see.web.teen' : 'family.see.web',
  ];
  const never: ServerMessageKey[] = ['family.never.messages', 'family.never.screens', 'family.never.typing', 'family.never.pages', 'family.never.contacts'];
  return { child_id: id, teen: child.teen, can_see: see.map((k) => l.t(k)), never_sees: never.map((k) => l.t(k)), rules: localizeDefaults(rules, l) };
}

// ───────────── signed delivery to the child's devices ─────────────

export async function signedRulesForDevice(deps: Deps, q: Queryable, device: DeviceActor): Promise<FamilyRulesResponse> {
  const child = await one<{ id: string }>(
    q,
    `SELECT u.id FROM users u JOIN organizations o ON o.id = u.organization_id
     WHERE u.id = $1 AND u.org_role = 'child' AND u.status = 'active' AND o.kind = 'family'`,
    [device.userId],
  );
  if (!child) throw errors.notFound('Family rules');
  const { rules } = await rulesForChild(q, device.organizationId, device.userId);
  const payload: SignedFamilyRulesPayload = {
    organization_id: device.organizationId,
    child_id: device.userId,
    device_id: device.deviceId,
    revision: await revisionOf(q, device.organizationId),
    issued_at: deps.now().toISOString(),
    rules: rules satisfies FamilyRules,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const key = deps.config.policySigningKey;
  return { payload_b64: bytes.toString('base64'), signature_b64: signEd25519(key.privateKey, bytes).toString('base64'), key_id: key.keyId };
}
