import {
  DEFAULT_WORKING_HOURS,
  MIN_INSIGHTS_GROUP_SIZE,
  UTILIZATION_BAND_PERCENT,
  type AppCategory,
  type AppCategoryDTO,
  type DayInsight,
  type ExpectedDay,
  type ExpectedHours,
  type PersonalInsights,
  type TeamInsights,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { getSettings, loadCalendars } from '../scheduling/service';
import { addDays, dateInTz } from '../scheduling/tz';
import { limitRows, resolveLimits } from '../timesheets/service';
import { dailyInsights, focusBlocks, summarize, type InsightBucket } from './compute';
import { expectedOn, summarizeExpected } from './expected';

interface Range {
  from: string;
  to: string;
}

async function bucketsFor(q: Queryable, orgId: string, userIds: string[], r: Range) {
  return many<InsightBucket & { user_id: string }>(
    q,
    `SELECT user_id, session_id, bucket_start, active_seconds, idle_seconds, data_quality
     FROM activity_buckets WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND bucket_start >= $3 AND bucket_start < $4
     ORDER BY bucket_start`,
    [orgId, userIds, r.from, r.to],
  );
}

/**
 * Category for each app the user ran, team-level rules first, then organization-wide.
 * Used by the apps report and insights.
 */
export async function categoryMap(q: Queryable, orgId: string, userId: string): Promise<Map<string, AppCategory>> {
  const rows = await many<{ app_identifier: string; category: AppCategory; team_id: string | null }>(
    q,
    `SELECT lower(app_identifier) AS app_identifier, category, team_id FROM app_categories
     WHERE organization_id = $1 AND (team_id IS NULL OR team_id IN (
       SELECT team_id FROM team_memberships WHERE user_id = $2 AND valid_to IS NULL))
     ORDER BY (team_id IS NULL) DESC`,
    [orgId, userId],
  );
  const m = new Map<string, AppCategory>();
  for (const r of rows) m.set(r.app_identifier, r.category); // team rows come last and win
  return m;
}

/** Local dates covered by `r` in `tz`. */
function datesIn(r: Range, tz: string): string[] {
  const first = dateInTz(Date.parse(r.from), tz);
  const last = dateInTz(Date.parse(r.to) - 1, tz);
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Expected hours for each person over the range, matched with what they tracked each day. */
async function expectedFor(q: Queryable, orgId: string, tracked: Map<string, DayInsight[]>, r: Range, tz: string): Promise<Map<string, ExpectedHours>> {
  const users = [...tracked.keys()];
  const dates = datesIn(r, tz);
  const out = new Map<string, ExpectedHours>();
  if (dates.length === 0) return out;
  const [cals, settings, limits] = await Promise.all([
    loadCalendars(q, orgId, users, dates[0]!, dates[dates.length - 1]!),
    getSettings(q, orgId),
    limitRows(q, orgId, users),
  ]);
  const dayHours = Number(settings.default_day_hours);
  for (const u of users) {
    const cal = cals.get(u)!;
    const byDate = new Map((tracked.get(u) ?? []).map((d) => [d.date, d]));
    const days: ExpectedDay[] = dates.map((date) => ({
      ...expectedOn(cal, date, resolveLimits(limits, u, date), dayHours),
      tracked_seconds: byDate.get(date)?.tracked_seconds ?? 0,
      focus_seconds: byDate.get(date)?.focus_seconds ?? 0,
    }));
    out.set(u, summarizeExpected(days, cal, resolveLimits(limits, u, dates[dates.length - 1]!), dayHours));
  }
  return out;
}

export async function personalInsights(q: Queryable, orgId: string, userId: string, r: Range, tz: string): Promise<PersonalInsights> {
  const buckets = await bucketsFor(q, orgId, [userId], r);
  const days = dailyInsights(buckets, tz, DEFAULT_WORKING_HOURS);
  const s = summarize(days);
  const blocks = focusBlocks(buckets);
  const categories = await categoryMap(q, orgId, userId);
  const apps = await many<{ app_identifier: string; seconds: number }>(
    q,
    `SELECT app_identifier, sum(duration_seconds)::int AS seconds FROM app_usage
     WHERE organization_id = $1 AND user_id = $2 AND started_at >= $3 AND started_at < $4 GROUP BY app_identifier`,
    [orgId, userId, r.from, r.to],
  );
  const byCategory = new Map<AppCategory | 'uncategorized', number>();
  for (const a of apps) {
    const c = categories.get(a.app_identifier.toLowerCase()) ?? 'uncategorized';
    byCategory.set(c, (byCategory.get(c) ?? 0) + a.seconds);
  }
  return {
    from: r.from,
    to: r.to,
    tz,
    working_hours: { ...DEFAULT_WORKING_HOURS },
    tracked_seconds: s.tracked_seconds,
    focus: {
      seconds: s.focus_seconds,
      blocks: s.focus_blocks,
      longest_block_seconds: Math.max(0, ...blocks.map((b) => b.minutes * 60)),
      share_percent: s.focus_share_percent,
    },
    after_hours_seconds: s.after_hours_seconds,
    weekend_seconds: s.weekend_seconds,
    long_days: s.long_days,
    breakless_days: s.breakless_days,
    longest_stretch_seconds: s.longest_stretch_seconds,
    work_apps: [...byCategory].map(([category, seconds]) => ({ category, seconds })).sort((a, b) => b.seconds - a.seconds),
    days,
    expected: (await expectedFor(q, orgId, new Map([[userId, days]]), r, tz)).get(userId)!,
  };
}

/** RPT-07: aggregates only, and only for groups large enough that nobody can be singled out. */
export async function teamInsights(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  teamId: string,
  r: Range,
  tz: string,
  requestId?: string,
): Promise<TeamInsights> {
  const team = await one<{ id: string; name: string }>(q, 'SELECT id, name FROM teams WHERE id = $1 AND organization_id = $2', [
    teamId,
    actor.organizationId,
  ]);
  if (!team) throw errors.notFound('Team');
  const members = (
    await many<{ user_id: string }>(
      q,
      `SELECT m.user_id FROM team_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 AND m.valid_to IS NULL AND u.status = 'active' AND u.tracking_enabled`,
      [teamId],
    )
  ).map((m) => m.user_id);
  if (members.length < MIN_INSIGHTS_GROUP_SIZE) {
    throw new AppError(
      403,
      'insufficient_group_size',
      `Team insights need at least ${MIN_INSIGHTS_GROUP_SIZE} tracked people so no one can be identified; this team has ${members.length}.`,
    );
  }
  const buckets = await bucketsFor(q, actor.organizationId, members, r);
  const perUser = new Map<string, InsightBucket[]>();
  for (const b of buckets) perUser.set(b.user_id, [...(perUser.get(b.user_id) ?? []), b]);
  const daily = new Map(members.map((u) => [u, dailyInsights(perUser.get(u) ?? [], tz, DEFAULT_WORKING_HOURS)]));
  const summaries = members.map((u) => summarize(daily.get(u)!));
  const expected = [...(await expectedFor(q, actor.organizationId, daily, r, tz)).values()];
  const band = (e: ExpectedHours) =>
    e.percent === null ? 'none' : e.percent < 100 - UTILIZATION_BAND_PERCENT ? 'under' : e.percent > 100 + UTILIZATION_BAND_PERCENT ? 'over' : 'about';
  const expectedTotal = expected.reduce((n, e) => n + e.expected_seconds, 0);
  const trackedForExpected = expected.reduce((n, e) => n + e.tracked_seconds, 0);
  const total = (f: (s: (typeof summaries)[number]) => number) => summaries.reduce((n, s) => n + f(s), 0);
  const tracked = total((s) => s.tracked_seconds);
  const focus = total((s) => s.focus_seconds);
  await audit(deps.pool, {
    organizationId: actor.organizationId,
    actor,
    action: 'insights.team_view',
    targetType: 'team',
    targetId: teamId,
    requestId,
    metadata: { members: members.length },
  });
  return {
    team,
    from: r.from,
    to: r.to,
    member_count: members.length,
    min_group_size: MIN_INSIGHTS_GROUP_SIZE,
    per_person: {
      tracked_seconds: Math.round(tracked / members.length),
      focus_seconds: Math.round(focus / members.length),
      after_hours_seconds: Math.round(total((s) => s.after_hours_seconds) / members.length),
      weekend_seconds: Math.round(total((s) => s.weekend_seconds) / members.length),
    },
    people_with_long_days: summaries.filter((s) => s.long_days > 0).length,
    people_with_after_hours: summaries.filter((s) => s.after_hours_seconds > 0).length,
    focus_share_percent: tracked > 0 ? Math.round((focus / tracked) * 100) : null,
    utilization: {
      expected_seconds: Math.round(expectedTotal / members.length),
      tracked_seconds: Math.round(trackedForExpected / members.length),
      percent: expectedTotal > 0 ? Math.round((trackedForExpected / expectedTotal) * 100) : null,
      under: expected.filter((e) => band(e) === 'under').length,
      about: expected.filter((e) => band(e) === 'about').length,
      over: expected.filter((e) => band(e) === 'over').length,
      none: expected.filter((e) => band(e) === 'none').length,
    },
  };
}

// ───────────── work-app categories (ACT-07) ─────────────

export async function listCategories(q: Queryable, orgId: string): Promise<AppCategoryDTO[]> {
  return many<AppCategoryDTO>(
    q,
    `SELECT c.id, c.team_id, t.name AS team_name, c.app_identifier, c.category, c.created_at
     FROM app_categories c LEFT JOIN teams t ON t.id = c.team_id
     WHERE c.organization_id = $1 ORDER BY t.name NULLS FIRST, lower(c.app_identifier)`,
    [orgId],
  );
}

export async function setCategory(
  q: Queryable,
  actor: UserActor,
  input: { team_id?: string | null; app_identifier: string; category: AppCategory },
  requestId?: string,
): Promise<AppCategoryDTO> {
  if (input.team_id) {
    const t = await one(q, 'SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2', [input.team_id, actor.organizationId]);
    if (!t) throw errors.notFound('Team');
  }
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO app_categories (organization_id, team_id, app_identifier, category, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(app_identifier))
     DO UPDATE SET category = EXCLUDED.category
     RETURNING id`,
    [actor.organizationId, input.team_id ?? null, input.app_identifier, input.category, actor.userId],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'app_category.set',
    targetType: 'app_category',
    targetId: r!.id,
    requestId,
    metadata: { category: input.category, team_id: input.team_id ?? null },
  });
  return (await listCategories(q, actor.organizationId)).find((c) => c.id === r!.id)!;
}

export async function deleteCategory(q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await q.query('DELETE FROM app_categories WHERE id = $1 AND organization_id = $2', [id, actor.organizationId]);
  if (r.rowCount === 0) throw errors.notFound('Category');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'app_category.delete', targetType: 'app_category', targetId: id, requestId });
}
