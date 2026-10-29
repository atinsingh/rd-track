import {
  approvalsBatchRequest,
  timesheetRuleUpdate,
  type ApprovalsBatchResponse,
  type ApprovalsBatchResult,
  type InboxCounts,
  type TimesheetRule,
  type TodosResponse,
} from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import type { Deps, UserActor } from '../context';
import { isAdmin } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, requireRole, userOf } from '../http';
import { getTimesheetRule, inboxCounts, setTimesheetRule, todosFor } from './engine/work';
import { AppError, errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { reviewCorrection } from './corrections/service';
import { reviewDeletionRequest } from './privacy/service';
import * as off from './scheduling/time-off';
import * as sched from './scheduling/service';
import { reviewTimesheet } from './timesheets/service';

/**
 * Stage 4 F2: one call to approve or send back many requests. Every item goes through
 * the same service function as its single-item endpoint — so the same rules (not your
 * own, people you manage, plan, current state) — in its own transaction: one refusal
 * never undoes the others.
 */
export async function approvalsRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  // Engine slice 3: what waits on me (the nav badge) and what I should do myself.
  app.get('/v1/inbox/counts', { config: { auth: 'user' } }, async (req): Promise<InboxCounts> => inboxCounts(deps, pool, userOf(req)));
  app.get('/v1/me/todos', { config: { auth: 'user' } }, async (req): Promise<TodosResponse> => ({ items: await todosFor(deps, pool, userOf(req)) }));
  app.get('/v1/admin/timesheet-rule', { config: { auth: 'user' } }, async (req): Promise<TimesheetRule> =>
    getTimesheetRule(pool, requireRole(req, ADMIN_ROLES).organizationId),
  );
  app.put('/v1/admin/timesheet-rule', { config: { auth: 'user' } }, async (req): Promise<TimesheetRule> => {
    const actor = requireRole(req, ADMIN_ROLES);
    const body = parse(timesheetRuleUpdate, req.body);
    return withTx(pool, (tx) => setTimesheetRule(tx, actor, body, req.id));
  });

  app.post('/v1/approvals/batch', { config: { auth: 'user' } }, async (req): Promise<ApprovalsBatchResponse> => {
    const actor = userOf(req);
    const body = parse(approvalsBatchRequest, req.body);
    const approve = body.action === 'approve';
    const seen = new Set<string>();
    const results: ApprovalsBatchResult[] = [];
    for (const item of body.items) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await withTx(pool, (tx) => reviewOne(deps, tx, actor, item.type, item.id, approve, body.note, req.id));
        results.push({ ...item, ok: true });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ ...item, ok: false, code: e.code, message: e.message });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    return { approved: approve ? ok : 0, rejected: approve ? 0 : ok, failed: results.length - ok, results };
  });
}

async function reviewOne(
  deps: Deps,
  tx: Parameters<typeof reviewCorrection>[1],
  actor: UserActor,
  type: ApprovalsBatchResult['type'],
  id: string,
  approve: boolean,
  note: string | undefined,
  requestId: string,
): Promise<unknown> {
  switch (type) {
    case 'correction':
      return reviewCorrection(deps, tx, actor, id, approve, note, requestId);
    case 'timesheet':
      return reviewTimesheet(deps, tx, actor, id, approve ? 'approve' : 'reject', note, requestId);
    case 'time_off':
      await sched.requireEntitlement(deps, tx, actor.organizationId, 'time_off');
      return off.reviewRequest(tx, actor, id, approve, note, requestId);
    case 'deletion_request':
      // Screenshot deletion requests are decided by org admins (engine slice 3: in the same inbox).
      if (!isAdmin(actor)) throw errors.forbidden();
      return reviewDeletionRequest(tx, actor, id, approve, requestId);
  }
}
