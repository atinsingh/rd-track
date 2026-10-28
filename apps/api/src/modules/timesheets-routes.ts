import {
  periodStartSchema,
  timesheetApproveRequest,
  timesheetNoteRequiredRequest,
  timesheetSubmitRequest,
  weekRangeQuery,
  workLimitsUpdateRequest,
} from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, requireRole, userOf } from '../http';
import { errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { managedTeamIds } from './authz';
import {
  getWorkLimits,
  myTimesheets,
  myWorkLimits,
  pendingTimesheets,
  reviewTimesheet,
  submitTimesheet,
  teamOvertime,
  timesheetFor,
  updateWorkLimits,
} from './timesheets/service';

type PeriodReq = { Params: { period_start: string } };
type RangeReq = { Querystring: { from?: string; to?: string } };

/** Weekly timesheets, approvals, work limits and overtime (plan entitlement `timesheets`). */
export async function timesheetRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const period = (v: string) => parse(periodStartSchema, v);

  // ───────── me ─────────
  app.get<RangeReq>('/v1/me/timesheets', user, async (req) => {
    const r = parse(weekRangeQuery, req.query);
    return { items: await myTimesheets(deps, pool, userOf(req), r.from, r.to) };
  });
  app.get<PeriodReq>('/v1/me/timesheets/:period_start', user, async (req) => {
    const a = userOf(req);
    return timesheetFor(deps, pool, a, a.userId, period(req.params.period_start), req.id);
  });
  app.post<PeriodReq>('/v1/me/timesheets/:period_start/submit', user, async (req) => {
    const p = period(req.params.period_start);
    const { note } = parse(timesheetSubmitRequest, req.body ?? {});
    return withTx(pool, (tx) => submitTimesheet(deps, tx, userOf(req), p, note, req.id));
  });
  app.get('/v1/me/work-limits', user, async (req) => myWorkLimits(deps, pool, userOf(req)));

  // ───────── reviewers ─────────
  app.get('/v1/timesheets/pending', user, async (req) => ({ items: await pendingTimesheets(deps, pool, userOf(req)) }));
  app.get<{ Params: { id: string; period_start: string } }>('/v1/users/:id/timesheets/:period_start', user, async (req) => {
    const id = parse(z.uuid(), req.params.id);
    const p = period(req.params.period_start);
    return withTx(pool, (tx) => timesheetFor(deps, tx, userOf(req), id, p, req.id));
  });
  for (const verb of ['approve', 'reject', 'reopen'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/timesheets/:id/${verb}`, user, async (req) => {
      const id = parse(z.uuid(), req.params.id);
      const { note } = parse(verb === 'approve' ? timesheetApproveRequest : timesheetNoteRequiredRequest, req.body ?? {});
      return withTx(pool, (tx) => reviewTimesheet(deps, tx, userOf(req), id, verb, note, req.id));
    });
  }
  app.get<{ Params: { id: string } } & RangeReq>('/v1/teams/:id/overtime', user, async (req) => {
    const a = userOf(req);
    const teamId = parse(z.uuid(), req.params.id);
    if (!(await managedTeamIds(pool, a.userId)).includes(teamId)) throw errors.forbidden();
    const r = parse(weekRangeQuery, req.query);
    return withTx(pool, (tx) => teamOvertime(deps, tx, a, teamId, r.from, r.to, req.id));
  });

  // ───────── admin ─────────
  app.get('/v1/admin/work-limits', user, async (req) => getWorkLimits(deps, pool, requireRole(req, ADMIN_ROLES)));
  app.put('/v1/admin/work-limits', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    const body = parse(workLimitsUpdateRequest, req.body);
    return withTx(pool, (tx) => updateWorkLimits(deps, tx, a, body, req.id));
  });
}
