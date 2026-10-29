import {
  billableHours,
  budgetStatus,
  formatDuration,
  lineAmountCents,
  type BudgetKind,
  type BudgetResets,
  type ProjectBudgetDTO,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, withTx, type Queryable } from '../../db/pool';
import { withScope } from '../../db/tenant-scope';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { notify } from '../engine/notify';
import { managedProjectIds } from '../authz';
import { assertInOrg } from '../org/service';
import { assertMoneyPlan, groupSeconds, hasMoneyPlan, timeWithBillRates } from './time';

/**
 * Project budgets (hours or amount), alert thresholds and stop-at-budget.
 *
 * Usage is computed on read from the time tables (one indexed aggregate per project) rather
 * than kept as a counter, so late offline batches, replays and approved corrections are
 * always reflected and nothing needs invalidating. Threshold alerts come from the
 * `budgets.check` worker job (every 10 minutes, see jobs/runner.ts) plus an immediate check
 * whenever a budget is saved; `budget_alerts_sent` makes each threshold alert once per
 * budget period. Periods are calendar months in UTC for monthly budgets.
 */

interface BudgetRow {
  id: string;
  organization_id: string;
  project_id: string;
  project_name: string;
  kind: BudgetKind;
  limit_value: number;
  currency: string | null;
  alert_thresholds: number[];
  stop_at_budget: boolean;
  resets: BudgetResets;
  updated_at: string;
}

const BUDGET_SELECT = `
  SELECT b.id, b.organization_id, b.project_id, p.name AS project_name, b.kind, b.limit_value, b.currency,
         b.alert_thresholds, b.stop_at_budget, b.resets, b.updated_at
  FROM project_budgets b JOIN projects p ON p.id = b.project_id`;

const FAR_PAST = '1970-01-01T00:00:00.000Z';

/** The budget period containing `at`. */
export function budgetPeriod(resets: BudgetResets, at: Date): { key: string; from: string | null; to: string | null } {
  if (resets === 'never') return { key: 'all', from: null, to: null };
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { key: from.toISOString().slice(0, 7), from: from.toISOString(), to: to.toISOString() };
}

/**
 * Usage of a budget in the period containing `at`, counting only time before `at`
 * (so a session that started offline before the budget ran out is judged fairly).
 */
async function usage(q: Queryable, b: BudgetRow, at: Date) {
  const period = budgetPeriod(b.resets, at);
  const to = period.to && new Date(period.to) < at ? period.to : at.toISOString();
  const rows = await timeWithBillRates(q, b.organization_id, { from: period.from ?? FAR_PAST, to }, { projectIds: [b.project_id] });
  const used_seconds = rows.reduce((n, r) => n + Number(r.seconds), 0);
  let used_cents: number | null = null;
  let unrated_seconds = 0;
  if (b.kind === 'amount') {
    used_cents = 0;
    // Same lines an invoice grouped by person would have: one per person and rate.
    const groups = groupSeconds(rows, (r) => (r.rate_cents !== null && r.rate_currency === b.currency ? `${r.user_id}|${r.rate_cents}` : null));
    for (const g of groups.values()) used_cents += lineAmountCents(billableHours(g.seconds), g.first.rate_cents!);
    unrated_seconds = rows.filter((r) => r.rate_cents === null || r.rate_currency !== b.currency).reduce((n, r) => n + Number(r.seconds), 0);
  }
  const used = b.kind === 'hours' ? used_seconds : used_cents!;
  const used_percent = Math.floor((used / b.limit_value) * 1000) / 10;
  return { period, used_seconds, used_cents, unrated_seconds, used_percent };
}

function toDTO(b: BudgetRow, u: Awaited<ReturnType<typeof usage>>): ProjectBudgetDTO {
  return {
    project_id: b.project_id,
    project_name: b.project_name,
    kind: b.kind,
    limit_hours: b.kind === 'hours' ? Math.round((b.limit_value / 3600) * 100) / 100 : null,
    limit_cents: b.kind === 'amount' ? b.limit_value : null,
    currency: b.currency,
    alert_thresholds: b.alert_thresholds,
    stop_at_budget: b.stop_at_budget,
    resets: b.resets,
    period: u.period,
    used_seconds: u.used_seconds,
    used_cents: u.used_cents,
    unrated_seconds: u.unrated_seconds,
    used_percent: u.used_percent,
    status: budgetStatus(u.used_percent, b.alert_thresholds),
    updated_at: b.updated_at,
  };
}

async function budgetFor(q: Queryable, orgId: string, projectId: string): Promise<BudgetRow | null> {
  return one<BudgetRow>(q, `${BUDGET_SELECT} WHERE b.organization_id = $1 AND b.project_id = $2`, [orgId, projectId]);
}

/** Org admins see every budget; project managers see budgets of projects they manage. */
export async function getProjectBudget(deps: Deps, q: Queryable, actor: UserActor, projectId: string): Promise<{ budget: ProjectBudgetDTO | null }> {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  if (!isAdmin(actor) && !(await managedProjectIds(q, actor.userId)).includes(projectId)) throw errors.forbidden();
  await assertMoneyPlan(deps, q, actor.organizationId);
  const b = await budgetFor(q, actor.organizationId, projectId);
  return { budget: b ? toDTO(b, await usage(q, b, deps.now())) : null };
}

export async function listBudgets(deps: Deps, q: Queryable, orgId: string): Promise<ProjectBudgetDTO[]> {
  const rows = await many<BudgetRow>(q, `${BUDGET_SELECT} WHERE b.organization_id = $1 ORDER BY p.name`, [orgId]);
  const out: ProjectBudgetDTO[] = [];
  for (const b of rows) out.push(toDTO(b, await usage(q, b, deps.now())));
  return out;
}

export async function putProjectBudget(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  projectId: string,
  input: {
    kind: BudgetKind;
    limit_hours?: number;
    limit_cents?: number;
    currency?: string;
    alert_thresholds: number[];
    stop_at_budget: boolean;
    resets: BudgetResets;
  },
  requestId?: string,
): Promise<{ budget: ProjectBudgetDTO }> {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  const limit = input.kind === 'hours' ? Math.round(input.limit_hours! * 3600) : input.limit_cents!;
  const currency = input.kind === 'amount' ? input.currency! : null;
  const thresholds = [...new Set(input.alert_thresholds)].sort((a, b) => a - b);
  const before = await budgetFor(q, actor.organizationId, projectId);
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO project_budgets (organization_id, project_id, kind, limit_value, currency, alert_thresholds, stop_at_budget, resets, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (project_id) DO UPDATE SET kind = EXCLUDED.kind, limit_value = EXCLUDED.limit_value, currency = EXCLUDED.currency,
       alert_thresholds = EXCLUDED.alert_thresholds, stop_at_budget = EXCLUDED.stop_at_budget, resets = EXCLUDED.resets,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id`,
    [actor.organizationId, projectId, input.kind, limit, currency, thresholds, input.stop_at_budget, input.resets, actor.userId],
  );
  // A new limit is a new budget for alerting: thresholds of the current period may alert again.
  if (before && (before.kind !== input.kind || Number(before.limit_value) !== limit || before.currency !== currency || before.resets !== input.resets)) {
    await q.query('DELETE FROM budget_alerts_sent WHERE budget_id = $1', [r!.id]);
  }
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: before ? 'budget.update' : 'budget.create',
    targetType: 'project',
    targetId: projectId,
    requestId,
    metadata: { kind: input.kind, limit_value: limit, currency, thresholds, stop_at_budget: input.stop_at_budget, resets: input.resets },
  });
  const b = (await budgetFor(q, actor.organizationId, projectId))!;
  await checkBudget(deps, q, b);
  return { budget: toDTO(b, await usage(q, b, deps.now())) };
}

export async function deleteProjectBudget(q: Queryable, actor: UserActor, projectId: string, requestId?: string) {
  const r = await q.query('DELETE FROM project_budgets WHERE organization_id = $1 AND project_id = $2', [actor.organizationId, projectId]);
  if (!r.rowCount) throw errors.notFound('Budget');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'budget.delete', targetType: 'project', targetId: projectId, requestId });
  return { ok: true };
}

function amountText(b: BudgetRow, cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: b.currency ?? 'USD' }).format(cents / 100);
}

/** Sends any threshold alert that is due for one budget (once per threshold per period). Returns how many were sent. */
export async function checkBudget(deps: Pick<Deps, 'now'>, q: Queryable, b: BudgetRow): Promise<number> {
  const u = await usage(q, b, deps.now());
  const due = b.alert_thresholds.filter((t) => u.used_percent >= t);
  if (due.length === 0) return 0;
  // Project managers open the project report; admins who don't manage it open Rates and budgets.
  const recipients = await many<{ id: string; manages: boolean }>(
    q,
    `SELECT pm.user_id AS id, true AS manages FROM project_memberships pm JOIN users u ON u.id = pm.user_id
     WHERE pm.organization_id = $1 AND pm.project_id = $2 AND pm.role = 'manager' AND pm.valid_to IS NULL AND u.status = 'active'
     UNION
     SELECT id, false FROM users WHERE organization_id = $1 AND status = 'active' AND org_role IN ('org_admin', 'super_admin')
       AND id NOT IN (SELECT user_id FROM project_memberships WHERE project_id = $2 AND role = 'manager' AND valid_to IS NULL)`,
    [b.organization_id, b.project_id],
  );
  const used = b.kind === 'hours' ? formatDuration(u.used_seconds) : amountText(b, u.used_cents!);
  const limit = b.kind === 'hours' ? formatDuration(b.limit_value) : amountText(b, b.limit_value);
  const when = b.resets === 'monthly' ? ' this month' : '';
  let sent = 0;
  // Only the highest newly crossed threshold produces a notification; lower ones are marked sent too.
  const fresh: number[] = [];
  for (const t of due) {
    const ins = await q.query(
      `INSERT INTO budget_alerts_sent (organization_id, budget_id, threshold, period) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [b.organization_id, b.id, t, u.period.key],
    );
    if (ins.rowCount) fresh.push(t);
  }
  if (fresh.length === 0) return 0;
  const top = Math.max(...fresh);
  const title = top >= 100 ? `${b.project_name} has reached its budget` : `${b.project_name} has used ${top}% of its budget`;
  let body = `${used} of ${limit} used${when}.`;
  if (b.stop_at_budget && top >= 100) {
    body += " New sessions on this project can't be started until the budget is raised or resets. Sessions already running are not stopped.";
  }
  const note = { kind: 'project_budget', category: 'budgets' as const, title, body };
  sent += await notify(q, b.organization_id, recipients.filter((r) => r.manages).map((r) => r.id), { ...note, link: `/projects?project=${b.project_id}` });
  sent += await notify(q, b.organization_id, recipients.filter((r) => !r.manages).map((r) => r.id), { ...note, link: '/admin/rates' });
  return sent;
}

/** Worker job `budgets.check`: every organization's budgets, each in its own tenant scope. */
export async function checkAllBudgets(deps: Deps): Promise<number> {
  const orgs = await many<{ organization_id: string }>(deps.pool, 'SELECT DISTINCT organization_id FROM project_budgets');
  let sent = 0;
  for (const { organization_id: orgId } of orgs) {
    sent += await withScope(orgId, () =>
      withTx(deps.pool, async (tx) => {
        if (!(await hasMoneyPlan(deps, tx, orgId))) return 0;
        let n = 0;
        for (const b of await many<BudgetRow>(tx, `${BUDGET_SELECT} WHERE b.organization_id = $1`, [orgId])) n += await checkBudget(deps, tx, b);
        return n;
      }),
    );
  }
  return sent;
}

/**
 * Stop at budget: true when `projectId` has a stop-at-budget budget that was used up
 * before `at`. Called only when a session *starts* (sessions/service.ts startSession);
 * a session that is already running is never stopped by a budget.
 */
export async function projectBudgetReached(deps: Pick<Deps, 'now'>, q: Queryable, orgId: string, projectId: string, at: Date): Promise<boolean> {
  const b = await one<BudgetRow>(q, `${BUDGET_SELECT} WHERE b.organization_id = $1 AND b.project_id = $2 AND b.stop_at_budget`, [
    orgId,
    projectId,
  ]);
  if (!b) return false;
  if (!(await hasMoneyPlan(deps, q, orgId))) return false; // budgets are inert without the Pro plan
  return (await usage(q, b, at)).used_percent >= 100;
}
