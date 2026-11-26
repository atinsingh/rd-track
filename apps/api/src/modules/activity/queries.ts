import {
  activityPercent,
  type ActivityResponse,
  type AppUsageResponse,
  type DailyProjectRow,
  type IntervalDTO,
  type MemberReportRow,
  type ProjectReport,
  type SessionDTO,
  type TeamReport,
  type WorkLocation,
} from '@rd/contracts';
import type { Deps } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { visibilityFor } from '../authz';
import { categoryMap } from '../insights/service';
import { idleAdjustmentsFor } from '../idle/service';
import { resolveFor } from '../policy/service';

interface Range {
  from: string;
  to: string;
}

const clip = (a: number, b: number, from: number, to: number) => Math.max(0, Math.min(b, to) - Math.max(a, from));

/** Paused intervals derived from session transitions, clipped to the range. */
async function pauseIntervals(q: Queryable, sessionIds: string[], r: Range, now: Date): Promise<(IntervalDTO & { session_id: string })[]> {
  if (sessionIds.length === 0) return [];
  const rows = await many<{ session_id: string; state: string; at: string }>(
    q,
    `SELECT session_id, state, at FROM session_transitions WHERE session_id = ANY($1::uuid[]) ORDER BY session_id, at, id`,
    [sessionIds],
  );
  const out: (IntervalDTO & { session_id: string })[] = [];
  const from = new Date(r.from).getTime();
  const to = new Date(r.to).getTime();
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!;
    if (t.state !== 'paused') continue;
    const next = rows[i + 1];
    const end = next && next.session_id === t.session_id ? new Date(next.at).getTime() : now.getTime();
    const a = Math.max(new Date(t.at).getTime(), from);
    const b = Math.min(end, to);
    if (b > a) out.push({ session_id: t.session_id, from: new Date(a).toISOString(), to: new Date(b).toISOString(), reason: 'paused' });
  }
  return out;
}

export async function sessionsFor(deps: Deps, q: Queryable, orgId: string, userId: string, r: Range): Promise<SessionDTO[]> {
  const rows = await many<Omit<SessionDTO, 'paused_seconds' | 'location_changed'>>(
    q,
    `SELECT s.id, s.user_id, s.device_id, s.project_id, p.name AS project_name, s.task_id, t.name AS task_name,
            s.state, s.source, s.corrected, s.started_at, s.ended_at,
            host(s.ip) AS ip, s.city, s.region, s.country_code,
            COALESCE(b.active, 0)::int AS active_seconds, COALESCE(b.idle, 0)::int AS idle_seconds,
            CASE WHEN s.source = 'manual'
                 THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::int
                 ELSE COALESCE(b.active, 0) + COALESCE(b.idle, 0) END::int AS tracked_seconds
     FROM work_sessions s
     LEFT JOIN projects p ON p.id = s.project_id
     LEFT JOIN tasks t ON t.id = s.task_id
     LEFT JOIN LATERAL (
       SELECT sum(active_seconds) AS active, sum(idle_seconds) AS idle FROM activity_buckets WHERE session_id = s.id
     ) b ON true
     WHERE s.organization_id = $1 AND s.user_id = $2 AND s.started_at < $4 AND (s.ended_at IS NULL OR s.ended_at > $3)
     ORDER BY s.started_at`,
    [orgId, userId, r.from, r.to],
  );
  const pauses = await pauseIntervals(q, rows.map((s) => s.id), { from: '1970-01-01T00:00:00Z', to: '9999-01-01T00:00:00Z' }, deps.now());
  const idle = await idleAdjustmentsFor(q, rows.map((s) => s.id));
  const usual = (await usualLocations(q, orgId, [userId], deps.now().toISOString())).get(userId);
  return rows.map((s) => ({
    ...s,
    location_changed: locationChanged(s, usual),
    idle_adjustments: idle.get(s.id) ?? [],
    paused_seconds: Math.round(
      pauses.filter((p) => p.session_id === s.id).reduce((n, p) => n + (new Date(p.to).getTime() - new Date(p.from).getTime()), 0) / 1000,
    ),
  }));
}

export async function activityFor(deps: Deps, q: Queryable, orgId: string, userId: string, r: Range): Promise<ActivityResponse> {
  const buckets = await many<ActivityResponse['buckets'][number]>(
    q,
    `SELECT bucket_start, active_seconds, idle_seconds, keyboard_count, mouse_count, data_quality
     FROM activity_buckets WHERE organization_id = $1 AND user_id = $2 AND bucket_start >= $3 AND bucket_start < $4
     ORDER BY bucket_start`,
    [orgId, userId, r.from, r.to],
  );
  const gaps = await many<IntervalDTO>(
    q,
    `SELECT greatest(gap_start, $3::timestamptz) AS "from", least(gap_end, $4::timestamptz) AS "to", reason
     FROM data_gaps WHERE organization_id = $1 AND user_id = $2 AND gap_start < $4 AND gap_end > $3 ORDER BY gap_start`,
    [orgId, userId, r.from, r.to],
  );
  const sessions = await many<{ id: string; source: string; started_at: string; ended_at: string | null }>(
    q,
    `SELECT id, source, started_at, ended_at FROM work_sessions
     WHERE organization_id = $1 AND user_id = $2 AND started_at < $4 AND (ended_at IS NULL OR ended_at > $3)`,
    [orgId, userId, r.from, r.to],
  );
  const pauses = await pauseIntervals(q, sessions.map((s) => s.id), r, deps.now());
  const from = new Date(r.from).getTime();
  const to = new Date(r.to).getTime();
  const manual = sessions
    .filter((s) => s.source === 'manual' && s.ended_at)
    .reduce((n, s) => n + clip(new Date(s.started_at).getTime(), new Date(s.ended_at!).getTime(), from, to), 0);

  let active = 0;
  let idle = 0;
  let tracked = 0;
  for (const b of buckets) {
    tracked += b.active_seconds + b.idle_seconds;
    if (b.data_quality !== 'permission_missing') {
      active += b.active_seconds;
      idle += b.idle_seconds;
    }
  }
  const span = (xs: IntervalDTO[]) => xs.reduce((n, x) => n + (new Date(x.to).getTime() - new Date(x.from).getTime()), 0) / 1000;
  return {
    from: r.from,
    to: r.to,
    buckets,
    gaps,
    pauses: pauses.map(({ session_id: _s, ...p }) => p),
    totals: {
      tracked_seconds: tracked,
      active_seconds: active,
      idle_seconds: idle,
      activity_percent: activityPercent(active, idle),
      manual_seconds: Math.round(manual / 1000),
      paused_seconds: Math.round(span(pauses)),
      gap_seconds: Math.round(span(gaps)),
    },
  };
}

export async function appsFor(q: Queryable, orgId: string, userId: string, r: Range): Promise<AppUsageResponse> {
  const apps = await many<Omit<AppUsageResponse['apps'][number], 'category'>>(
    q,
    `SELECT app_identifier, max(app_name) AS app_name, domain, sum(duration_seconds)::int AS seconds
     FROM app_usage WHERE organization_id = $1 AND user_id = $2 AND started_at >= $3 AND started_at < $4
     GROUP BY app_identifier, domain ORDER BY seconds DESC LIMIT 50`,
    [orgId, userId, r.from, r.to],
  );
  const categories = await categoryMap(q, orgId, userId);
  return {
    from: r.from,
    to: r.to,
    apps: apps.map((a) => ({ ...a, category: categories.get(a.app_identifier.toLowerCase()) ?? null })),
  };
}

// ───────────── team & project reports ─────────────

/** What someone is doing right now, whatever the report's range. */
export type LiveStatus = 'tracking' | 'paused' | 'idle' | 'offline';
/** Not yet in the shared contract: the web reads both fields as optional. */
export type MemberLiveRow = MemberReportRow & { status: LiveStatus; screenshot_count: number | null };

// The agent heartbeats every minute and sends each minute's bucket within seconds.
const OFFLINE_AFTER_MS = 3 * 60_000;

// ponytail: one org-wide daily target; make it a policy field when teams need different hours.
const TARGET_SECONDS_PER_DAY = 8 * 3600;
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Office quits and the daily-hours target for one person, in their office time zone. */
async function attendanceFor(deps: Deps, q: Queryable, orgId: string, userId: string, r: Range, tz: string) {
  const wh = (await resolveFor(deps, q, orgId, userId)).settings.work_hours;
  const zone = wh?.timezone ?? tz;
  const now = deps.now().toISOString();
  // A quit is either the agent's own `quit_during_hours` stop, or an unannounced end: the agent
  // was killed (force quit, crash) inside office hours, went silent for over 5 minutes, and its
  // session was later superseded by a new start. The last activity minute marks when it left.
  // ponytail: a pause right before a kill counts as away; fold paused time out if that matters.
  const quits = await one<{ n: number; away: number }>(
    q,
    `WITH ends AS (
       SELECT s.ended_at AS left_at FROM work_sessions s
       WHERE s.organization_id = $1 AND s.user_id = $2 AND s.stop_reason = 'quit_during_hours'
       UNION ALL
       SELECT h.left_at FROM work_sessions s
       CROSS JOIN LATERAL (SELECT coalesce(max(b.bucket_start) + interval '1 minute', s.started_at) AS left_at
                           FROM activity_buckets b WHERE b.session_id = s.id) h
       WHERE $8::boolean AND s.organization_id = $1 AND s.user_id = $2 AND s.stop_reason = 'superseded'
         AND s.ended_at - h.left_at > interval '5 minutes'
         AND extract(isodow FROM h.left_at AT TIME ZONE $6)::int = ANY($9::int[])
         AND (h.left_at AT TIME ZONE $6)::time >= $10::time AND (h.left_at AT TIME ZONE $6)::time < $7::time)
     SELECT count(*)::int AS n,
            coalesce(sum(greatest(0, EXTRACT(EPOCH FROM (least(coalesce(nx.started_at, $5::timestamptz), c.cap) - e.left_at)))), 0)::int AS away
     FROM ends e
     LEFT JOIN LATERAL (SELECT n.started_at FROM work_sessions n WHERE n.user_id = $2 AND n.started_at >= e.left_at
                        ORDER BY n.started_at LIMIT 1) nx ON true
     CROSS JOIN LATERAL (SELECT (((e.left_at AT TIME ZONE $6)::date + $7::time) AT TIME ZONE $6) AS cap) c
     WHERE e.left_at >= $3 AND e.left_at < $4`,
    [orgId, userId, r.from, r.to, now, zone, wh?.end ?? '24:00', wh != null, wh?.days ?? WEEKDAYS, wh?.start ?? '00:00'],
  );
  // Completed office days only: today still has hours to go.
  const target = await one<{ work_days: number; under: number }>(
    q,
    `WITH days AS (
       SELECT g::date AS d FROM generate_series(($3::timestamptz AT TIME ZONE $5)::date,
         least((($4::timestamptz - interval '1 second') AT TIME ZONE $5)::date, ($6::timestamptz AT TIME ZONE $5)::date - 1),
         interval '1 day') g
       WHERE extract(isodow FROM g)::int = ANY($7::int[])),
     t AS (
       SELECT (bucket_start AT TIME ZONE $5)::date AS d, active_seconds + idle_seconds AS s FROM activity_buckets
       WHERE organization_id = $1 AND user_id = $2 AND bucket_start >= $3 AND bucket_start < $4
       UNION ALL
       SELECT (started_at AT TIME ZONE $5)::date, EXTRACT(EPOCH FROM (ended_at - started_at))::int FROM work_sessions
       WHERE organization_id = $1 AND user_id = $2 AND source = 'manual' AND started_at >= $3 AND started_at < $4),
     per AS (SELECT days.d, coalesce(sum(t.s), 0) AS s FROM days LEFT JOIN t ON t.d = days.d GROUP BY days.d)
     SELECT count(*)::int AS work_days, count(*) FILTER (WHERE s < $8)::int AS under FROM per`,
    [orgId, userId, r.from, r.to, zone, now, wh?.days ?? WEEKDAYS, TARGET_SECONDS_PER_DAY],
  );
  return {
    quits_during_hours: quits?.n ?? 0,
    quit_away_seconds: quits?.away ?? 0,
    work_days: target?.work_days ?? 0,
    days_under_target: target?.under ?? 0,
    target_seconds_per_day: TARGET_SECONDS_PER_DAY,
  };
}
// ponytail: the default idle threshold (300 s), not each person's policy value; resolve it per person if policies diverge.
const IDLE_AFTER_MS = 5 * 60_000;

function liveStatus(
  open: { state: string; started_at: string; last_seen_at: string | null; last_bucket: string | null; last_active: string | null } | undefined,
  activityShared: boolean,
  now: number,
): LiveStatus {
  if (!open) return 'offline';
  const seen = Math.max(open.last_seen_at ? Date.parse(open.last_seen_at) : 0, open.last_bucket ? Date.parse(open.last_bucket) + 60_000 : 0);
  if (now - seen > OFFLINE_AFTER_MS) return 'offline';
  if (open.state === 'paused') return 'paused';
  // Idle comes from activity, so it is only told to viewers who may see activity.
  if (activityShared && now - Date.parse(open.last_active ?? open.started_at) > IDLE_AFTER_MS) return 'idle';
  return 'tracking';
}

/** One team's report, or with `teamId` null everyone active in the organization (reported as a team with the org's id). */
export async function teamReport(
  deps: Deps,
  q: Queryable,
  orgId: string,
  teamId: string | null,
  r: Range,
  tz: string,
  projectId: string | null = null,
): Promise<TeamReport & { members: MemberLiveRow[] }> {
  const team =
    teamId === null
      ? { id: orgId, name: 'Everyone' }
      : await one<{ id: string; name: string }>(q, 'SELECT id, name FROM teams WHERE id = $1 AND organization_id = $2', [teamId, orgId]);
  if (!team) throw errors.notFound('Team');
  const members = await many<{ user_id: string; display_name: string }>(
    q,
    teamId === null
      ? `SELECT id AS user_id, display_name FROM users WHERE organization_id = $1 AND status = 'active' ORDER BY display_name`
      : `SELECT u.id AS user_id, u.display_name FROM team_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND m.valid_to IS NULL AND u.status = 'active' ORDER BY u.display_name`,
    [teamId ?? orgId],
  );
  const ids = members.map((m) => m.user_id);

  const agg = await many<{ user_id: string; active: number; idle: number; tracked: number; missing: number; days: number }>(
    q,
    `SELECT user_id,
            sum(active_seconds) FILTER (WHERE data_quality <> 'permission_missing')::int AS active,
            sum(idle_seconds) FILTER (WHERE data_quality <> 'permission_missing')::int AS idle,
            sum(active_seconds + idle_seconds)::int AS tracked,
            count(*) FILTER (WHERE data_quality = 'permission_missing')::int AS missing,
            count(DISTINCT (bucket_start AT TIME ZONE $5)::date)::int AS days
     FROM activity_buckets WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND bucket_start >= $3 AND bucket_start < $4
       AND ($6::uuid IS NULL OR session_id IN (SELECT id FROM work_sessions WHERE project_id = $6))
     GROUP BY user_id`,
    [orgId, ids, r.from, r.to, tz, projectId],
  );
  const manual = await many<{ user_id: string; seconds: number }>(
    q,
    `SELECT user_id, sum(EXTRACT(EPOCH FROM (least(ended_at, $4::timestamptz) - greatest(started_at, $3::timestamptz))))::int AS seconds
     FROM work_sessions WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND source = 'manual'
       AND started_at < $4 AND ended_at > $3 AND ($5::uuid IS NULL OR project_id = $5) GROUP BY user_id`,
    [orgId, ids, r.from, r.to, projectId],
  );
  const gaps = await many<{ user_id: string; seconds: number }>(
    q,
    `SELECT user_id, sum(EXTRACT(EPOCH FROM (least(gap_end, $4::timestamptz) - greatest(gap_start, $3::timestamptz))))::int AS seconds
     FROM data_gaps WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND gap_start < $4 AND gap_end > $3
       AND ($5::uuid IS NULL OR session_id IN (SELECT id FROM work_sessions WHERE project_id = $5)) GROUP BY user_id`,
    [orgId, ids, r.from, r.to, projectId],
  );
  const sessions = await many<{ id: string; user_id: string }>(
    q,
    `SELECT id, user_id FROM work_sessions WHERE organization_id = $1 AND user_id = ANY($2::uuid[])
       AND started_at < $4 AND (ended_at IS NULL OR ended_at > $3) AND ($5::uuid IS NULL OR project_id = $5)`,
    [orgId, ids, r.from, r.to, projectId],
  );
  const pauses = await pauseIntervals(q, sessions.map((s) => s.id), r, deps.now());
  const pausedBy = new Map<string, number>();
  for (const p of pauses) {
    const uid = sessions.find((s) => s.id === p.session_id)!.user_id;
    pausedBy.set(uid, (pausedBy.get(uid) ?? 0) + (new Date(p.to).getTime() - new Date(p.from).getTime()) / 1000);
  }

  const open = await many<{ user_id: string; state: string; started_at: string; last_seen_at: string | null; last_bucket: string | null; last_active: string | null }>(
    q,
    `SELECT DISTINCT ON (s.user_id) s.user_id, s.state, s.started_at, d.last_seen_at,
            (SELECT max(b.bucket_start) FROM activity_buckets b WHERE b.session_id = s.id) AS last_bucket,
            (SELECT max(b.bucket_start) FROM activity_buckets b WHERE b.session_id = s.id AND b.active_seconds > 0) AS last_active
     FROM work_sessions s LEFT JOIN devices d ON d.id = s.device_id
     WHERE s.organization_id = $1 AND s.user_id = ANY($2::uuid[]) AND s.state IN ('active', 'paused') AND s.ended_at IS NULL
     ORDER BY s.user_id, s.started_at DESC`,
    [orgId, ids],
  );
  // The same screenshots the person's day page lists.
  // Counted per project, so each count is only shown where that project shares screenshots.
  const shots = await many<{ user_id: string; project_id: string | null; n: number }>(
    q,
    `SELECT sc.user_id, ws.project_id, count(*)::int AS n FROM screenshots sc
     LEFT JOIN work_sessions ws ON ws.id = sc.session_id
     WHERE sc.organization_id = $1 AND sc.user_id = ANY($2::uuid[]) AND sc.status IN ('stored', 'verifying')
       AND sc.captured_at >= $3 AND sc.captured_at < $4
       AND ($5::uuid IS NULL OR ws.project_id = $5)
     GROUP BY sc.user_id, ws.project_id`,
    [orgId, ids, r.from, r.to, projectId],
  );
  // Screenshots are often shared per project: the same projects the person's own visibility check looks at.
  const tracked = await many<{ user_id: string; project_id: string }>(
    q,
    `SELECT DISTINCT user_id, project_id FROM work_sessions
     WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND project_id IS NOT NULL AND started_at > $3::timestamptz - interval '90 days'`,
    [orgId, ids, deps.now().toISOString()],
  );
  const usual = await usualLocations(q, orgId, ids, deps.now().toISOString());
  const located = await many<{ user_id: string; city: string | null; country_code: string }>(
    q,
    `SELECT user_id, city, country_code FROM work_sessions
     WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND country_code IS NOT NULL
       AND started_at >= $3 AND started_at < $4 AND ($5::uuid IS NULL OR project_id = $5)
     ORDER BY started_at DESC`,
    [orgId, ids, r.from, r.to, projectId],
  );
  const now = deps.now().getTime();
  const shareCache = new Map<string, boolean>();
  const sharesScreenshots = async (userId: string, project: string): Promise<boolean> => {
    const key = `${userId}:${project}`;
    let v = shareCache.get(key);
    if (v === undefined) {
      const { settings } = await resolveFor(deps, q, orgId, userId, { projectId: project });
      v = settings.screenshots.enabled && settings.viewers.manager_can_view_screenshots;
      shareCache.set(key, v);
    }
    return v;
  };

  let anyActivity = false;
  let anyApps = false;
  let anyScreens = false;
  const rows: MemberLiveRow[] = [];
  for (const m of members) {
    const a = agg.find((x) => x.user_id === m.user_id);
    const vis = await visibilityFor(deps, q, orgId, m.user_id);
    // Org-level sharing covers screenshots outside a project; each project decides for its own.
    const orgShares = vis.screenshots;
    let shotCount = 0;
    for (const g of shots) {
      if (g.user_id !== m.user_id) continue;
      if (g.project_id === null ? orgShares : await sharesScreenshots(m.user_id, g.project_id)) shotCount += g.n;
    }
    for (const t of tracked) {
      if (vis.screenshots) break;
      if (t.user_id !== m.user_id) continue;
      vis.screenshots = await sharesScreenshots(m.user_id, t.project_id);
    }
    anyActivity ||= vis.activity;
    anyApps ||= vis.apps;
    anyScreens ||= vis.screenshots;
    const notes: string[] = [];
    if (a && a.missing > 0) notes.push(`${a.missing} min without OS permission`);
    rows.push({
      user_id: m.user_id,
      display_name: m.display_name,
      tracked_seconds: a?.tracked ?? 0,
      active_seconds: vis.activity ? (a?.active ?? 0) : 0,
      idle_seconds: vis.activity ? (a?.idle ?? 0) : 0,
      activity_percent: vis.activity && a ? activityPercent(a.active ?? 0, a.idle ?? 0) : null,
      gap_seconds: gaps.find((g) => g.user_id === m.user_id)?.seconds ?? 0,
      paused_seconds: Math.round(pausedBy.get(m.user_id) ?? 0),
      manual_seconds: manual.find((x) => x.user_id === m.user_id)?.seconds ?? 0,
      days_active: a?.days ?? 0,
      permission_missing_minutes: a?.missing ?? 0,
      notes,
      ...(await attendanceFor(deps, q, orgId, m.user_id, r, tz)),
      status: liveStatus(open.find((o) => o.user_id === m.user_id), vis.activity, now),
      screenshot_count: vis.screenshots ? shotCount : null,
      ...locationSummary(located.filter((s) => s.user_id === m.user_id), usual.get(m.user_id) ?? null),
    });
  }

  const daily = (await dailyByProject(q, orgId, ids, r, tz)).map((d) => ({
    ...d,
    projects: projectId ? d.projects.filter((p) => p.project_id === projectId) : d.projects,
  }));
  return {
    team: { id: team.id, name: team.name, member_count: members.length },
    from: r.from,
    to: r.to,
    members: rows,
    daily,
    visibility: { activity: anyActivity, apps: anyApps, screenshots: anyScreens },
  };
}

/**
 * Each person's usual work location: the (country, city) their sessions most often started from
 * in the 30 days before `until` (now, so the Team count and the day view agree; ties: the most recent). Sessions without a location don't count.
 */
async function usualLocations(q: Queryable, orgId: string, userIds: string[], until: string): Promise<Map<string, WorkLocation>> {
  const rows = await many<{ user_id: string } & WorkLocation>(
    q,
    `SELECT DISTINCT ON (user_id) user_id, city, country_code FROM work_sessions
     WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) AND country_code IS NOT NULL
       AND started_at >= $3::timestamptz - interval '30 days' AND started_at < $3::timestamptz
     GROUP BY user_id, city, country_code
     ORDER BY user_id, count(*) DESC, max(started_at) DESC`,
    [orgId, userIds, until],
  );
  return new Map(rows.map((r) => [r.user_id, { city: r.city, country_code: r.country_code }]));
}

/** A known location that differs in country, or in city when the city is known. No usual location: no change. */
function locationChanged(s: { city: string | null; country_code: string | null }, usual: WorkLocation | null | undefined): boolean {
  if (!usual || !s.country_code) return false;
  return s.country_code !== usual.country_code || (s.city !== null && s.city !== usual.city);
}

/** `located` is newest first. */
function locationSummary(located: { city: string | null; country_code: string }[], usual: WorkLocation | null) {
  const latest = located[0];
  return {
    location: latest ? { city: latest.city, country_code: latest.country_code } : null,
    usual_location: usual,
    location_changes: located.filter((s) => locationChanged(s, usual)).length,
  };
}

async function dailyByProject(q: Queryable, orgId: string, userIds: string[], r: Range, tz: string): Promise<DailyProjectRow[]> {
  const rows = await many<{ date: string; project_id: string | null; project_name: string | null; seconds: number }>(
    q,
    `WITH t AS (
       SELECT (b.bucket_start AT TIME ZONE $5)::date AS date, s.project_id, (b.active_seconds + b.idle_seconds) AS seconds
       FROM activity_buckets b JOIN work_sessions s ON s.id = b.session_id
       WHERE b.organization_id = $1 AND b.user_id = ANY($2::uuid[]) AND b.bucket_start >= $3 AND b.bucket_start < $4
       UNION ALL
       SELECT (s.started_at AT TIME ZONE $5)::date, s.project_id, EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::int
       FROM work_sessions s
       WHERE s.organization_id = $1 AND s.user_id = ANY($2::uuid[]) AND s.source = 'manual'
         AND s.started_at >= $3 AND s.started_at < $4)
     SELECT t.date::text AS date, t.project_id, p.name AS project_name, sum(t.seconds)::int AS seconds
     FROM t LEFT JOIN projects p ON p.id = t.project_id
     GROUP BY t.date, t.project_id, p.name ORDER BY t.date, p.name NULLS LAST`,
    [orgId, userIds, r.from, r.to, tz],
  );
  const byDate = new Map<string, DailyProjectRow>();
  for (const row of rows) {
    const d = byDate.get(row.date) ?? { date: row.date, projects: [] };
    d.projects.push({ project_id: row.project_id, project_name: row.project_name ?? 'No project', seconds: row.seconds });
    byDate.set(row.date, d);
  }
  return [...byDate.values()];
}

export async function projectReport(q: Queryable, orgId: string, projectId: string, r: Range, tz: string): Promise<ProjectReport> {
  const project = await one<{ id: string; name: string }>(q, 'SELECT id, name FROM projects WHERE id = $1 AND organization_id = $2', [
    projectId,
    orgId,
  ]);
  if (!project) throw errors.notFound('Project');
  const time = `
    SELECT s.user_id, (b.bucket_start AT TIME ZONE $4)::date AS date, (b.active_seconds + b.idle_seconds) AS seconds
    FROM activity_buckets b JOIN work_sessions s ON s.id = b.session_id
    WHERE s.organization_id = $1 AND s.project_id = $5 AND b.bucket_start >= $2 AND b.bucket_start < $3
    UNION ALL
    SELECT s.user_id, (s.started_at AT TIME ZONE $4)::date, EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::int
    FROM work_sessions s WHERE s.organization_id = $1 AND s.project_id = $5 AND s.source = 'manual'
      AND s.started_at >= $2 AND s.started_at < $3`;
  const params = [orgId, r.from, r.to, tz, projectId];
  const members = await many<ProjectReport['members'][number]>(
    q,
    `WITH t AS (${time}) SELECT u.id AS user_id, u.display_name, sum(t.seconds)::int AS seconds
     FROM t JOIN users u ON u.id = t.user_id GROUP BY u.id, u.display_name ORDER BY u.display_name`,
    params,
  );
  const daily = await many<ProjectReport['daily'][number]>(
    q,
    `WITH t AS (${time}) SELECT date::text AS date, sum(seconds)::int AS seconds FROM t GROUP BY date ORDER BY date`,
    params,
  );
  return { project, from: r.from, to: r.to, members, daily };
}
