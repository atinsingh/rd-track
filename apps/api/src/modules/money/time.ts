import { hasEntitlement } from '@rd/contracts';
import type { Deps } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { currentSubscription } from '../billing/service';

/**
 * Time that money is computed from, on the same basis as the project report
 * (`activity/queries.ts` `projectReport`): agent sessions count their measured minute
 * buckets that start inside the range; manual entries (approved manual time) count their
 * span when they start inside the range. Each session row carries the date it started in
 * the employee's timezone, which is the date its pay or bill rate is resolved at.
 *
 * TODO(timesheets): once approved timesheets land (migration 004), invoices and payroll
 * must count approved time only. This stream uses all recorded time.
 */

export interface TimeRow {
  session_id: string;
  user_id: string;
  user_name: string;
  email: string;
  project_id: string | null;
  project_name: string | null;
  /** YYYY-MM-DD: the session's start date in the employee's timezone */
  work_date: string;
  seconds: number;
}

export interface RatedTimeRow extends TimeRow {
  rate_id: string | null;
  rate_cents: number | null;
  rate_currency: string | null;
  rate_effective_from: string | null;
}

export interface TimeFilter {
  projectIds?: string[];
  userIds?: string[];
}

const BASE = `
  WITH t AS (
    SELECT b.session_id, sum(b.active_seconds + b.idle_seconds)::bigint AS seconds
    FROM activity_buckets b JOIN work_sessions s ON s.id = b.session_id
    WHERE s.organization_id = $1 AND b.bucket_start >= $2 AND b.bucket_start < $3
      AND ($4::uuid[] IS NULL OR s.project_id = ANY($4)) AND ($5::uuid[] IS NULL OR s.user_id = ANY($5))
    GROUP BY b.session_id
    UNION ALL
    SELECT s.id, EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::bigint
    FROM work_sessions s
    WHERE s.organization_id = $1 AND s.source = 'manual' AND s.ended_at IS NOT NULL
      AND s.started_at >= $2 AND s.started_at < $3
      AND ($4::uuid[] IS NULL OR s.project_id = ANY($4)) AND ($5::uuid[] IS NULL OR s.user_id = ANY($5))
  ),
  x AS (
    SELECT s.id AS session_id, s.user_id, u.display_name AS user_name, u.email, s.project_id, p.name AS project_name,
           (s.started_at AT TIME ZONE u.timezone)::date AS work_date, sum(t.seconds)::bigint AS seconds
    FROM t JOIN work_sessions s ON s.id = t.session_id JOIN users u ON u.id = s.user_id
    LEFT JOIN projects p ON p.id = s.project_id
    GROUP BY s.id, s.user_id, u.display_name, u.email, s.project_id, p.name, u.timezone
    HAVING sum(t.seconds) > 0
  )`;

function params(orgId: string, r: { from: string; to: string }, f: TimeFilter) {
  return [orgId, r.from, r.to, f.projectIds ?? null, f.userIds ?? null];
}

/** Recorded time with the bill rate in effect for each session (person-specific beats the project default). */
export async function timeWithBillRates(q: Queryable, orgId: string, r: { from: string; to: string }, f: TimeFilter): Promise<RatedTimeRow[]> {
  return many<RatedTimeRow>(
    q,
    `${BASE}
     SELECT x.session_id, x.user_id, x.user_name, x.email, x.project_id, x.project_name, x.work_date::text AS work_date,
            x.seconds, r.id AS rate_id, r.amount_cents AS rate_cents, r.currency AS rate_currency,
            r.effective_from::text AS rate_effective_from
     FROM x LEFT JOIN LATERAL (
       SELECT br.id, br.amount_cents, br.currency, br.effective_from FROM bill_rates br
       WHERE br.organization_id = $1 AND br.project_id = x.project_id
         AND (br.user_id = x.user_id OR br.user_id IS NULL) AND br.effective_from <= x.work_date
       ORDER BY (br.user_id IS NULL), br.effective_from DESC LIMIT 1
     ) r ON true
     ORDER BY x.project_name, x.user_name, x.work_date`,
    params(orgId, r, f),
  );
}

/** Recorded time with each person's pay rate in effect on the session's start date. */
export async function timeWithPayRates(q: Queryable, orgId: string, r: { from: string; to: string }, f: TimeFilter): Promise<RatedTimeRow[]> {
  return many<RatedTimeRow>(
    q,
    `${BASE}
     SELECT x.session_id, x.user_id, x.user_name, x.email, x.project_id, x.project_name, x.work_date::text AS work_date,
            x.seconds, r.id AS rate_id, r.amount_cents AS rate_cents, r.currency AS rate_currency,
            r.effective_from::text AS rate_effective_from
     FROM x LEFT JOIN LATERAL (
       SELECT pr.id, pr.amount_cents, pr.currency, pr.effective_from FROM pay_rates pr
       WHERE pr.organization_id = $1 AND pr.user_id = x.user_id AND pr.effective_from <= x.work_date
       ORDER BY pr.effective_from DESC LIMIT 1
     ) r ON true
     ORDER BY x.user_name, x.work_date`,
    params(orgId, r, f),
  );
}

/** Group rows and sum their seconds; `keyOf` returns null to drop a row. */
export function groupSeconds<T extends { seconds: number }>(rows: readonly T[], keyOf: (r: T) => string | null): Map<string, { first: T; seconds: number }> {
  const out = new Map<string, { first: T; seconds: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null) continue;
    const g = out.get(k);
    if (g) g.seconds += Number(r.seconds);
    else out.set(k, { first: r, seconds: Number(r.seconds) });
  }
  return out;
}

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw errors.validation('Unknown timezone');
  }
}

/** Inclusive calendar dates in a timezone → a half-open UTC instant range. */
export async function dateRange(q: Queryable, fromDate: string, toDate: string, tz: string, maxDays = 366): Promise<{ from: string; to: string }> {
  assertTimezone(tz);
  if (toDate < fromDate) throw errors.validation('The period must end on or after its start');
  if ((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000 + 1 > maxDays) {
    throw errors.validation(`A period may not exceed ${maxDays} days`);
  }
  const r = await one<{ from: string; to: string }>(
    q,
    `SELECT ($1::date::timestamp AT TIME ZONE $3) AS "from", (($2::date + 1)::timestamp AT TIME ZONE $3) AS "to"`,
    [fromDate, toDate, tz],
  );
  return r!;
}

export async function userTimezone(q: Queryable, userId: string): Promise<string> {
  return (await one<{ timezone: string }>(q, 'SELECT timezone FROM users WHERE id = $1', [userId]))?.timezone ?? 'UTC';
}

/** Plan gate for the whole money area (`budgets_invoicing`; trials get Pro). */
export async function hasMoneyPlan(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string): Promise<boolean> {
  const sub = await currentSubscription(q, orgId, deps.now());
  return sub.status === 'trialing' || hasEntitlement(sub.plan, 'budgets_invoicing');
}

export async function assertMoneyPlan(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string): Promise<void> {
  if (!(await hasMoneyPlan(deps, q, orgId))) {
    throw errors.paymentRequired('Rates, budgets, invoices and payroll export are part of the Pro plan.');
  }
}
