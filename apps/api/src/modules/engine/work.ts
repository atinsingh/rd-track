import {
  DEFAULT_TIMESHEET_RULE,
  DEVICE_STALE_WORKING_DAYS,
  addCalendarDays,
  hasEntitlement,
  isoWeekStart,
  type InboxCounts,
  type TimesheetRule,
  type TodoDTO,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, withTx, type Queryable } from '../../db/pool';
import { audit } from '../audit/service';
import { currentSubscription } from '../billing/service';
import { dateInTz, isValidTimeZone, isoWeekday, zonedTimeToMs } from '../scheduling/tz';
import { publish, reviewersOf } from './events';
import { langOfUser } from '../../i18n';

/**
 * Engine slice 3: work items and rules (docs/design/07-product-review.md §3).
 * Counts and to-dos are computed from the source tables with the same rules as the
 * review screens, so they can't drift; the rules run hourly and publish events that
 * notify through the one notification service.
 */

const HOUR = 3600_000;

// ───────────── inbox counts ─────────────

/** Matches the reviewer rule of each queue: the person's team managers, or org admins. */
const MANAGES = (alias: string) => `($3::boolean OR EXISTS (
  SELECT 1 FROM team_memberships m JOIN team_memberships t ON t.team_id = m.team_id
  WHERE m.user_id = $2 AND m.role = 'manager' AND m.valid_to IS NULL AND t.user_id = ${alias}.user_id AND t.valid_to IS NULL))`;

export async function inboxCounts(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor): Promise<InboxCounts> {
  const sub = await currentSubscription(q, actor.organizationId, deps.now());
  const has = (e: Parameters<typeof hasEntitlement>[1]) => sub.status === 'trialing' || hasEntitlement(sub.plan, e);
  const args = [actor.organizationId, actor.userId, isAdmin(actor)];
  const count = async (sql: string) => (await one<{ n: number }>(q, sql, args))!.n;
  const corrections = await count(
    `SELECT count(*)::int AS n FROM time_corrections c WHERE c.organization_id = $1 AND c.status = 'pending' AND c.user_id <> $2 AND ${MANAGES('c')}`,
  );
  const timesheets = has('timesheets')
    ? await count(`SELECT count(*)::int AS n FROM timesheets s WHERE s.organization_id = $1 AND s.status = 'submitted' AND s.user_id <> $2 AND ${MANAGES('s')}`)
    : 0;
  const time_off = has('time_off')
    ? await count(`SELECT count(*)::int AS n FROM time_off_requests r WHERE r.organization_id = $1 AND r.status = 'pending' AND r.user_id <> $2 AND ${MANAGES('r')}`)
    : 0;
  const deletion_requests = isAdmin(actor)
    ? await count(`SELECT count(*)::int AS n FROM deletion_requests d WHERE d.organization_id = $1 AND d.status = 'pending' AND d.requester_id <> $2 AND $3::boolean`)
    : 0;
  const expenses = has('expenses')
    ? await count(`SELECT count(*)::int AS n FROM expenses e WHERE e.organization_id = $1 AND e.status = 'pending' AND e.user_id <> $2 AND ${MANAGES('e')}`)
    : 0;
  return { corrections, timesheets, time_off, deletion_requests, expenses, total: corrections + timesheets + time_off + deletion_requests + expenses };
}

// ───────────── timesheet rule ─────────────

export async function getTimesheetRule(q: Queryable, orgId: string): Promise<TimesheetRule> {
  const r = await one<TimesheetRule>(
    q,
    `SELECT enabled, due_weekday, to_char(due_time, 'HH24:MI') AS due_time, escalate_after_hours FROM timesheet_rules WHERE organization_id = $1`,
    [orgId],
  );
  return r ?? DEFAULT_TIMESHEET_RULE;
}

export async function setTimesheetRule(q: Queryable, actor: UserActor, rule: TimesheetRule, requestId?: string): Promise<TimesheetRule> {
  await q.query(
    `INSERT INTO timesheet_rules (organization_id, enabled, due_weekday, due_time, escalate_after_hours, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, due_weekday = EXCLUDED.due_weekday, due_time = EXCLUDED.due_time,
       escalate_after_hours = EXCLUDED.escalate_after_hours, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [actor.organizationId, rule.enabled, rule.due_weekday, rule.due_time, rule.escalate_after_hours, actor.userId],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'timesheet_rule.update', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { ...rule } });
  return getTimesheetRule(q, actor.organizationId);
}

/** When the timesheet for the week starting `week` is due, in `tz`. */
export function dueAt(rule: Pick<TimesheetRule, 'due_weekday' | 'due_time'>, week: string, tz: string): number {
  return zonedTimeToMs(addCalendarDays(week, 7 + rule.due_weekday - 1), rule.due_time, tz);
}

/**
 * The reminder: the working day before the deadline, at the same wall-clock time (calendar
 * days, not 24-hour steps, so a daylight-saving change doesn't move it).
 */
export function reminderAt(rule: Pick<TimesheetRule, 'due_weekday' | 'due_time'>, week: string, tz: string): number {
  let day = addCalendarDays(week, 7 + rule.due_weekday - 2);
  while (isoWeekday(day) >= 6) day = addCalendarDays(day, -1);
  return zonedTimeToMs(day, rule.due_time, tz);
}

interface Person {
  id: string;
  display_name: string;
  timezone: string;
}

/**
 * Weeks where the person tracked time and hasn't submitted: the last two finished weeks,
 * and this week once `currentFrom` (its reminder time, when a rule is on) has passed.
 */
async function unsubmittedWeeks(
  q: Queryable,
  orgId: string,
  p: Person,
  nowMs: number,
  currentFrom: ((week: string) => number) | null,
): Promise<{ week: string; status: string }[]> {
  const tz = isValidTimeZone(p.timezone) ? p.timezone : 'UTC';
  const thisWeek = isoWeekStart(dateInTz(nowMs, tz));
  const weeks = [addCalendarDays(thisWeek, -14), addCalendarDays(thisWeek, -7)];
  if (currentFrom && nowMs >= currentFrom(thisWeek)) weeks.push(thisWeek);
  const out: { week: string; status: string }[] = [];
  for (const week of weeks) {
    const sheet = await one<{ status: string }>(q, 'SELECT status FROM timesheets WHERE organization_id = $1 AND user_id = $2 AND period_start = $3', [orgId, p.id, week]);
    if (sheet && (sheet.status === 'submitted' || sheet.status === 'approved')) continue;
    const worked = await one(
      q,
      `SELECT 1 FROM work_sessions WHERE organization_id = $1 AND user_id = $2
         AND started_at >= ($3::date::timestamp AT TIME ZONE $4) AND started_at < (($3::date + 7)::timestamp AT TIME ZONE $4) LIMIT 1`,
      [orgId, p.id, week, tz],
    );
    if (worked) out.push({ week, status: sheet?.status ?? 'draft' });
  }
  return out;
}

const weekLabel = (week: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${week}T00:00:00Z`));
const dueLabel = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(ms));

/** Hourly: reminders, overdue notices and reviewer digests for every org with the rule on. */
export async function runTimesheetRules(deps: Pick<Deps, 'now' | 'pool'>): Promise<number> {
  const now = deps.now().getTime();
  const orgs = await many<{ organization_id: string }>(deps.pool, 'SELECT organization_id FROM timesheet_rules WHERE enabled');
  let published = 0;
  for (const { organization_id: orgId } of orgs) {
    published += await withTx(deps.pool, async (q) => {
      const sub = await currentSubscription(q, orgId, deps.now());
      if (sub.status !== 'trialing' && !hasEntitlement(sub.plan, 'timesheets')) return 0;
      const rule = await getTimesheetRule(q, orgId);
      const people = await many<Person>(
        q,
        `SELECT id, display_name, timezone FROM users WHERE organization_id = $1 AND status = 'active' AND tracking_enabled AND password_hash IS NOT NULL`,
        [orgId],
      );
      let n = 0;
      const escalate = new Map<string, { week: string; names: string[] }>();
      for (const p of people) {
        const tz = isValidTimeZone(p.timezone) ? p.timezone : 'UTC';
        for (const { week } of await unsubmittedWeeks(q, orgId, p, now, (w) => reminderAt(rule, w, tz))) {
          const due = dueAt(rule, week, tz);
          const base = { organizationId: orgId, subjectUserId: p.id, data: { week, week_label: weekLabel(week), due_at: new Date(due).toISOString(), due_label: dueLabel(due, tz), tz } };
          if (now >= reminderAt(rule, week, tz) && now < due) {
            if (await publish(q, { ...base, type: 'timesheet.due_soon', dedupeKey: `ts_due:${p.id}:${week}` })) n++;
          }
          if (now >= due) {
            if (await publish(q, { ...base, type: 'timesheet.overdue', dedupeKey: `ts_overdue:${p.id}:${week}` })) n++;
          }
          if (rule.escalate_after_hours > 0 && now >= due + rule.escalate_after_hours * HOUR) {
            for (const r of await reviewersOf(q, orgId, p.id)) {
              const e = escalate.get(`${r}|${week}`) ?? { week, names: [] };
              e.names.push(p.display_name);
              escalate.set(`${r}|${week}`, e);
            }
          }
        }
      }
      // One digest per reviewer and week.
      for (const [key, e] of escalate) {
        const reviewer = key.split('|')[0]!;
        // Team managers open their team; admins reviewing people without a manager open People.
        const manages = await one(q, `SELECT 1 FROM team_memberships WHERE user_id = $1 AND role = 'manager' AND valid_to IS NULL LIMIT 1`, [reviewer]);
        const ok = await publish(q, {
          organizationId: orgId,
          type: 'timesheet.escalated',
          subjectUserId: reviewer,
          data: { week: e.week, week_label: weekLabel(e.week), count: e.names.length, names: e.names.sort().slice(0, 5), link: manages ? '/team' : '/admin/users' },
          dedupeKey: `ts_escalate:${reviewer}:${e.week}`,
        });
        if (ok) n++;
      }
      return n;
    });
  }
  return published;
}

// ───────────── device health ─────────────

/** Mon–Fri days after `fromMs`'s date up to and including `toMs`'s date (UTC). */
export function workingDaysBetween(fromMs: number, toMs: number): number {
  let n = 0;
  let d = dateInTz(fromMs, 'UTC');
  const end = dateInTz(toMs, 'UTC');
  while (d < end) {
    d = addCalendarDays(d, 1);
    if (isoWeekday(d) <= 5) n++;
  }
  return n;
}

/** Hourly: a computer that hasn't synced for a few working days nudges its owner (only them). */
export async function runDeviceHealth(deps: Pick<Deps, 'now' | 'pool'>): Promise<number> {
  const now = deps.now().getTime();
  const rows = await many<{ id: string; organization_id: string; user_id: string; name: string; last_seen_at: string }>(
    deps.pool,
    `SELECT d.id, d.organization_id, d.user_id, d.name, d.last_seen_at FROM devices d JOIN users u ON u.id = d.user_id
     WHERE d.credential_status = 'active' AND d.last_seen_at IS NOT NULL AND d.last_seen_at < $1 AND u.status = 'active' AND u.tracking_enabled`,
    [new Date(now - DEVICE_STALE_WORKING_DAYS * 24 * HOUR).toISOString()],
  );
  let n = 0;
  for (const d of rows) {
    if (workingDaysBetween(Date.parse(d.last_seen_at), now) < DEVICE_STALE_WORKING_DAYS) continue;
    const ok = await withTx(deps.pool, (q) =>
      publish(q, {
        organizationId: d.organization_id,
        type: 'device.stale',
        subjectUserId: d.user_id,
        data: { device_id: d.id, device_name: d.name, last_seen_at: d.last_seen_at },
        dedupeKey: `stale:${d.id}:${d.last_seen_at}`,
      }),
    );
    if (ok) n++;
  }
  return n;
}

// ───────────── the person's own to-dos ─────────────

export async function todosFor(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor): Promise<TodoDTO[]> {
  const now = deps.now().getTime();
  const items: TodoDTO[] = [];
  const me = await one<Person & { tracking_enabled: boolean }>(q, 'SELECT id, display_name, timezone, tracking_enabled FROM users WHERE id = $1', [actor.userId]);
  if (!me) return items;
  const tz = isValidTimeZone(me.timezone) ? me.timezone : 'UTC';
  const l = await langOfUser(q, actor.userId);
  const sub = await currentSubscription(q, actor.organizationId, deps.now());
  if (me.tracking_enabled && (sub.status === 'trialing' || hasEntitlement(sub.plan, 'timesheets'))) {
    const rule = await getTimesheetRule(q, actor.organizationId);
    const current = rule.enabled ? (w: string) => reminderAt(rule, w, tz) : null;
    for (const { week, status } of await unsubmittedWeeks(q, actor.organizationId, me, now, current)) {
      const due = rule.enabled ? dueAt(rule, week, tz) : null;
      const sentBack = status === 'rejected';
      items.push({
        id: `timesheet:${week}`,
        kind: sentBack ? 'resubmit_timesheet' : 'submit_timesheet',
        title: l.t(sentBack ? 'todo.resubmit' : 'todo.submit', { week: l.dayMonth(week) }),
        body: sentBack ? l.t('todo.sentBack') : due ? l.t('todo.due', { due: l.dueTime(due, tz) }) : l.t('todo.check'),
        link: `/me/time?week=${week}`,
        due_at: due ? new Date(due).toISOString() : null,
        overdue: due !== null && now >= due,
      });
    }
  }
  const devices = await many<{ id: string; name: string; last_seen_at: string | null; permissions: Record<string, string> | null }>(
    q,
    `SELECT id, name, last_seen_at, permissions FROM devices WHERE user_id = $1 AND credential_status = 'active' ORDER BY name`,
    [actor.userId],
  );
  if (me.tracking_enabled && devices.length === 0) {
    // Onboarding (slice 4c): someone who tracks but has no computer connected yet.
    items.push({
      id: 'connect_computer',
      kind: 'connect_computer',
      title: l.t('todo.connect.title'),
      body: l.t('todo.connect.body'),
      link: '/me/computers',
      due_at: null,
      overdue: false,
    });
  }
  for (const d of devices) {
    for (const key of ['input_monitoring', 'screen_recording'] as const) {
      if (d.permissions?.[key] === 'denied') {
        items.push({
          id: `permission:${d.id}:${key}`,
          kind: 'allow_permission',
          title: l.t('todo.allow.title', { permission: l.t(`perm.${key}`), device: d.name }),
          body: l.t('todo.allow.body'),
          link: '/me/privacy',
          due_at: null,
          overdue: false,
        });
      }
    }
    if (me.tracking_enabled && d.last_seen_at && workingDaysBetween(Date.parse(d.last_seen_at), now) >= DEVICE_STALE_WORKING_DAYS) {
      items.push({
        id: `stale:${d.id}`,
        kind: 'open_agent',
        title: l.t('todo.open.title', { device: d.name }),
        body: l.t('todo.open.body'),
        link: '/me',
        due_at: null,
        overdue: false,
      });
    }
  }
  return items;
}
