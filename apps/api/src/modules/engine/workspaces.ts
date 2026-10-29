import {
  DEVICE_STALE_WORKING_DAYS,
  SETUP_STEPS,
  TEAM_SUMMARY_MIN_PEOPLE,
  addCalendarDays,
  hasEntitlement,
  isoWeekStart,
  type AdminOverview,
  type AuditPerson,
  type MoneyOverview,
  type OrgWeekSummary,
  type SetupStep,
  type SetupStepKey,
  type UnbilledClient,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { currentSubscription } from '../billing/service';
import { listBudgets } from '../money/budgets';
import { openInvoices } from '../money/invoices';
import { dateRange, timeWithBillRates } from '../money/time';
import { dateInTz, isValidTimeZone, zonedTimeToMs } from '../scheduling/tz';
import { workingDaysBetween } from './work';

/**
 * Role workspaces (engine slice 4, docs/design/07-product-review.md §4): the numbers each
 * role's home is built from. Everything here is a count or a total; nothing reads
 * activity levels, apps or screenshots, and team hours need at least
 * TEAM_SUMMARY_MIN_PEOPLE people behind them.
 */

const zoneOf = (tz: string | null | undefined) => (tz && isValidTimeZone(tz) ? tz : 'UTC');

// ───────────── org admin: setup and health ─────────────

async function setupSteps(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor): Promise<SetupStep[]> {
  const orgId = actor.organizationId;
  const r = (await one<Record<Exclude<SetupStepKey, 'choose_plan'>, boolean>>(
    q,
    `SELECT
       (SELECT mfa_enabled FROM users WHERE id = $2) AS turn_on_mfa,
       EXISTS (SELECT 1 FROM policy_versions WHERE organization_id = $1) AS review_policy,
       EXISTS (SELECT 1 FROM users WHERE organization_id = $1 AND id <> $2) AS invite_people,
       EXISTS (SELECT 1 FROM team_memberships WHERE organization_id = $1 AND role = 'manager' AND valid_to IS NULL) AS create_team,
       EXISTS (SELECT 1 FROM devices WHERE organization_id = $1) AS connect_computer,
       COALESCE((SELECT enabled FROM timesheet_rules WHERE organization_id = $1), false) AS timesheet_deadline`,
    [orgId, actor.userId],
  ))!;
  const sub = await currentSubscription(q, orgId, deps.now());
  const timesheets = sub.status === 'trialing' || hasEntitlement(sub.plan, 'timesheets');
  const done: Record<SetupStepKey, boolean> = { ...r, choose_plan: sub.status !== 'trialing' };
  return SETUP_STEPS.filter((k) => k !== 'timesheet_deadline' || timesheets).map((key) => ({
    key,
    done: done[key],
    optional: key === 'timesheet_deadline',
  }));
}

/** Tracked seconds per person: measured minutes plus approved manual time, as on the team report. */
async function trackedByUser(q: Queryable, orgId: string, fromMs: number, toMs: number): Promise<Map<string, number>> {
  const rows = await many<{ user_id: string; seconds: string }>(
    q,
    `WITH t AS (
       SELECT user_id, sum(active_seconds + idle_seconds)::bigint AS s FROM activity_buckets
       WHERE organization_id = $1 AND bucket_start >= $2 AND bucket_start < $3 GROUP BY user_id
       UNION ALL
       SELECT user_id, sum(EXTRACT(EPOCH FROM (ended_at - started_at)))::bigint FROM work_sessions
       WHERE organization_id = $1 AND source = 'manual' AND ended_at IS NOT NULL AND started_at >= $2 AND started_at < $3
       GROUP BY user_id
     )
     SELECT user_id, sum(s)::bigint AS seconds FROM t GROUP BY user_id`,
    [orgId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.seconds)]));
}

export async function orgWeekSummary(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, tz: string): Promise<OrgWeekSummary> {
  const now = deps.now().getTime();
  const week = isoWeekStart(dateInTz(now, tz));
  const start = zonedTimeToMs(week, '00:00', tz);
  const prevStart = zonedTimeToMs(addCalendarDays(week, -7), '00:00', tz);
  const [current, previous] = await Promise.all([trackedByUser(q, orgId, start, now), trackedByUser(q, orgId, prevStart, start)]);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const members = await many<{ team_id: string; name: string; user_id: string | null }>(
    q,
    `SELECT t.id AS team_id, t.name, u.id AS user_id
     FROM teams t
     LEFT JOIN team_memberships m ON m.team_id = t.id AND m.valid_to IS NULL
     LEFT JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE t.organization_id = $1
     ORDER BY t.name`,
    [orgId],
  );
  const teams = new Map<string, { id: string; name: string; people: Set<string> }>();
  for (const m of members) {
    const t = teams.get(m.team_id) ?? { id: m.team_id, name: m.name, people: new Set<string>() };
    if (m.user_id) t.people.add(m.user_id);
    teams.set(m.team_id, t);
  }
  return {
    week,
    tracked_seconds: sum(current),
    previous_week_seconds: sum(previous),
    people_tracked: [...current.values()].filter((s) => s > 0).length,
    teams: [...teams.values()].map((t) => ({
      id: t.id,
      name: t.name,
      members: t.people.size,
      tracked_seconds: t.people.size >= TEAM_SUMMARY_MIN_PEOPLE ? [...t.people].reduce((n, id) => n + (current.get(id) ?? 0), 0) : null,
    })),
  };
}

export async function adminOverview(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor): Promise<AdminOverview> {
  const orgId = actor.organizationId;
  const me = await one<{ timezone: string }>(q, 'SELECT timezone FROM users WHERE id = $1', [actor.userId]);
  const people = (await one<AdminOverview['people']>(
    q,
    `SELECT
       count(*) FILTER (WHERE password_hash IS NOT NULL)::int AS active,
       count(*) FILTER (WHERE password_hash IS NULL)::int AS invited,
       count(*) FILTER (WHERE password_hash IS NOT NULL AND NOT tracking_enabled)::int AS tracking_off,
       count(*) FILTER (WHERE tracking_enabled AND NOT EXISTS (
         SELECT 1 FROM team_memberships t JOIN team_memberships m ON m.team_id = t.team_id
         WHERE t.user_id = u.id AND t.valid_to IS NULL AND m.role = 'manager' AND m.valid_to IS NULL AND m.user_id <> u.id))::int AS without_reviewer
     FROM users u WHERE organization_id = $1 AND status = 'active'`,
    [orgId],
  ))!;
  const devices = await many<{ last_seen_at: string | null; permissions: Record<string, string> | null }>(
    q,
    `SELECT last_seen_at, permissions FROM devices WHERE organization_id = $1 AND credential_status = 'active'`,
    [orgId],
  );
  const now = deps.now().getTime();
  return {
    setup: await setupSteps(deps, q, actor),
    people,
    devices: {
      active: devices.length,
      stale: devices.filter((d) => d.last_seen_at && workingDaysBetween(Date.parse(d.last_seen_at), now) >= DEVICE_STALE_WORKING_DAYS).length,
      permission_issues: devices.filter((d) => Object.values(d.permissions ?? {}).includes('denied')).length,
      never_synced: devices.filter((d) => !d.last_seen_at).length,
    },
    week: await orgWeekSummary(deps, q, orgId, zoneOf(me?.timezone)),
  };
}

// ───────────── finance: period close ─────────────

const UNBILLED_LOOKBACK_DAYS = 90;

async function unbilledClients(q: Queryable, orgId: string, today: string, tz: string): Promise<UnbilledClient[]> {
  const clients = await many<{ id: string; name: string; billed_to: string | null; project_ids: string[] }>(
    q,
    `SELECT c.id, c.name,
            (SELECT max(period_to)::text FROM invoices i WHERE i.client_id = c.id AND i.status = 'issued') AS billed_to,
            array_agg(p.id) AS project_ids
     FROM clients c JOIN projects p ON p.client_id = c.id
     WHERE c.organization_id = $1 AND NOT c.archived
     GROUP BY c.id, c.name ORDER BY c.name`,
    [orgId],
  );
  const floor = addCalendarDays(today, -UNBILLED_LOOKBACK_DAYS);
  const out: UnbilledClient[] = [];
  for (const c of clients) {
    const since = c.billed_to && addCalendarDays(c.billed_to, 1) > floor ? addCalendarDays(c.billed_to, 1) : floor;
    if (since > today) continue;
    const range = await dateRange(q, since, today, tz);
    const rows = await timeWithBillRates(q, orgId, range, { projectIds: c.project_ids });
    const seconds = rows.reduce((n, r) => n + Number(r.seconds), 0);
    if (seconds > 0) out.push({ client_id: c.id, client_name: c.name, since, seconds });
  }
  return out;
}

export async function moneyOverview(deps: Deps, q: Queryable, actor: UserActor): Promise<MoneyOverview> {
  const orgId = actor.organizationId;
  const me = await one<{ timezone: string }>(q, 'SELECT timezone FROM users WHERE id = $1', [actor.userId]);
  const tz = zoneOf(me?.timezone);
  const today = dateInTz(deps.now().getTime(), tz);
  const from = `${today.slice(0, 7)}-01`;
  const to = addCalendarDays(`${addCalendarDays(from, 31).slice(0, 7)}-01`, -1);
  const sub = await currentSubscription(q, orgId, deps.now());
  const timesheets =
    sub.status === 'trialing' || hasEntitlement(sub.plan, 'timesheets')
      ? (await one<NonNullable<MoneyOverview['timesheets']>>(
          q,
          `SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved,
                  count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
                  count(*) FILTER (WHERE status = 'rejected')::int AS sent_back,
                  COALESCE(sum((approved_totals->>'total_seconds')::bigint) FILTER (WHERE status = 'approved'), 0)::bigint AS approved_seconds
           FROM timesheets WHERE organization_id = $1 AND period_start BETWEEN $2 AND $3`,
          [orgId, from, to],
        ))!
      : null;
  if (timesheets) timesheets.approved_seconds = Number(timesheets.approved_seconds);
  const paid = await many<{ currency: string; total_cents: string; n: number }>(
    q,
    `SELECT currency, sum(total_cents)::bigint AS total_cents, count(*)::int AS n FROM invoices
     WHERE organization_id = $1 AND status = 'issued' AND paid_on BETWEEN $2 AND $3 GROUP BY currency ORDER BY currency`,
    [orgId, from, to],
  );
  const budgets = (await listBudgets(deps, q, orgId)).filter((b) => b.used_percent >= 80).sort((a, b) => b.used_percent - a.used_percent);
  return {
    period: { from, to },
    timesheets,
    open_invoices: (await openInvoices(q, orgId)).map((i) => ({ ...i, total_cents: Number(i.total_cents) })),
    paid_this_period: {
      count: paid.reduce((n, p) => n + p.n, 0),
      by_currency: paid.map((p) => ({ currency: p.currency, total_cents: Number(p.total_cents) })),
    },
    unbilled: await unbilledClients(q, orgId, today, tz),
    budgets,
  };
}

// ───────────── auditor ─────────────

/** Everyone in the organization by name only, for audit filters. Auditors don't get the People admin list. */
export async function auditPeople(q: Queryable, orgId: string): Promise<AuditPerson[]> {
  return many<AuditPerson>(
    q,
    `SELECT id, display_name,
            CASE WHEN status = 'deactivated' THEN 'deactivated' WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END AS status
     FROM users WHERE organization_id = $1 ORDER BY display_name`,
    [orgId],
  );
}
