import {
  calendarDate,
  holidayCreateRequest,
  schedulingSettingsUpdate,
  shiftCreateRequest,
  shiftOverrideRequest,
  shiftUpdateRequest,
  timeOffAdjustmentCreate,
  timeOffAssignmentCreate,
  timeOffPolicyCreate,
  timeOffPolicyUpdate,
  timeOffRequestCreate,
  timeOffReviewRequest,
} from '@rd/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { withTx } from '../../db/pool';
import { ADMIN_ROLES, requireRole, userOf } from '../../http';
import { errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { assertSameOrgUser, managedTeamIds } from '../authz';
import * as sched from './service';
import * as off from './time-off';

type RangeReq = FastifyRequest<{ Querystring: { from?: string; to?: string } }>;
type IdReq = FastifyRequest<{ Params: { id: string } }>;

const optionalUuid = (v: unknown) => (v === undefined || v === '' ? undefined : parse(z.uuid(), v));
/** A path id that isn't a UUID can't name anything: 404 rather than a database error. */
const idOf = (req: IdReq) => {
  if (!z.uuid().safeParse(req.params.id).success) throw errors.notFound();
  return req.params.id;
};

/**
 * Schedules, attendance, holidays and time off (Stage 3). Plan gates: `schedules` (Pro) for
 * shifts and attendance, `time_off` (Standard, Pro) for time off; holidays and the team
 * calendar serve both.
 */
export async function schedulingRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const gate = (a: UserActor, ...es: sched.SchedulingEntitlement[]) => sched.requireEntitlement(deps, pool, a.organizationId, ...es);
  const admin = async (req: FastifyRequest, ...es: sched.SchedulingEntitlement[]) => {
    const a = requireRole(req, ADMIN_ROLES);
    await gate(a, ...es);
    return a;
  };

  // ───────── me ─────────
  app.get('/v1/me/schedule', user, async (req: RangeReq) => {
    const a = userOf(req);
    await gate(a, 'schedules');
    return sched.mySchedule(pool, a, sched.parseDateRange(req.query));
  });
  app.get('/v1/me/attendance', user, async (req: RangeReq) => {
    const a = userOf(req);
    await gate(a, 'schedules');
    return sched.attendanceFor(deps, pool, a.organizationId, a.userId, sched.parseDateRange(req.query));
  });
  app.get('/v1/me/time-off', user, async (req) => {
    const a = userOf(req);
    await gate(a, 'time_off');
    return off.myTimeOff(pool, a);
  });
  app.get<{ Querystring: { start_date?: string; end_date?: string; partial_hours?: string } }>('/v1/me/time-off/estimate', user, async (req) => {
    const a = userOf(req);
    await gate(a, 'time_off');
    const start = parse(calendarDate, req.query.start_date);
    const end = parse(calendarDate, req.query.end_date ?? req.query.start_date);
    if (end < start) throw errors.validation('Ends before it starts');
    const partial = req.query.partial_hours ? parse(z.coerce.number().gt(0).max(24), req.query.partial_hours) : undefined;
    return { hours: await off.estimateHours(pool, a.organizationId, a.userId, { start_date: start, end_date: end, partial_hours: partial }) };
  });
  app.post('/v1/me/time-off/requests', user, async (req, reply) => {
    const a = userOf(req);
    await gate(a, 'time_off');
    const body = parse(timeOffRequestCreate, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => off.createRequest(tx, a, body, req.id)));
  });
  app.post('/v1/me/time-off/requests/:id/cancel', user, async (req: IdReq) => {
    const a = userOf(req);
    await gate(a, 'time_off');
    return withTx(pool, (tx) => off.cancelRequest(deps, tx, a, idOf(req), req.id));
  });

  // ───────── review ─────────
  app.get('/v1/time-off/pending', user, async (req) => {
    const a = userOf(req);
    await gate(a, 'time_off');
    return { items: await off.pendingForReviewer(pool, a) };
  });
  for (const verb of ['approve', 'deny'] as const) {
    app.post(`/v1/time-off/requests/:id/${verb}`, user, async (req: IdReq) => {
      const a = userOf(req);
      await gate(a, 'time_off');
      const { note } = parse(timeOffReviewRequest, req.body ?? {});
      return withTx(pool, (tx) => off.reviewRequest(tx, a, idOf(req), verb === 'approve', note, req.id));
    });
  }

  // ───────── team views (team managers; audited per member) ─────────
  async function managedTeam(req: FastifyRequest<{ Params: { id: string } }>) {
    const a = userOf(req);
    if (!(await managedTeamIds(pool, a.userId)).includes(req.params.id)) throw errors.forbidden();
    return a;
  }
  async function auditMembers(a: UserActor, members: string[], teamId: string, action: string, requestId: string) {
    for (const m of members) {
      if (m === a.userId) continue;
      await audit(pool, {
        organizationId: a.organizationId,
        actor: a,
        action,
        targetType: 'team',
        targetId: teamId,
        targetUserId: m,
        requestId,
        metadata: { admin: isAdmin(a) },
      });
    }
  }
  type TeamRangeReq = FastifyRequest<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>;
  app.get('/v1/teams/:id/attendance', user, async (req: TeamRangeReq) => {
    const a = await managedTeam(req);
    await gate(a, 'schedules');
    const r = await sched.teamAttendance(deps, pool, a.organizationId, req.params.id, sched.parseDateRange(req.query, 31));
    await auditMembers(a, r.members.map((m) => m.user_id), req.params.id, 'attendance.view', req.id);
    return r;
  });
  app.get('/v1/teams/:id/calendar', user, async (req: TeamRangeReq) => {
    const a = await managedTeam(req);
    const includes = await gate(a, 'schedules', 'time_off');
    const r = await sched.teamCalendar(pool, a.organizationId, req.params.id, sched.parseDateRange(req.query), includes);
    await auditMembers(a, r.members.map((m) => m.user_id), req.params.id, 'team_calendar.view', req.id);
    return r;
  });

  // ───────── admin: settings, shifts, overrides ─────────
  app.get('/v1/admin/scheduling/settings', user, async (req) => sched.getSettings(pool, (await admin(req, 'schedules', 'time_off')).organizationId));
  app.put('/v1/admin/scheduling/settings', user, async (req) => {
    const a = await admin(req, 'schedules', 'time_off');
    const body = parse(schedulingSettingsUpdate, req.body);
    return withTx(pool, (tx) => sched.updateSettings(tx, a, body, req.id));
  });
  app.get<{ Querystring: { user_id?: string } }>('/v1/admin/shifts', user, async (req) => {
    const a = await admin(req, 'schedules');
    return { items: await sched.listShifts(pool, a.organizationId, optionalUuid(req.query.user_id)) };
  });
  app.post('/v1/admin/shifts', user, async (req, reply) => {
    const a = await admin(req, 'schedules');
    const body = parse(shiftCreateRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => sched.createShift(tx, a, body, req.id)));
  });
  app.patch('/v1/admin/shifts/:id', user, async (req: IdReq) => {
    const a = await admin(req, 'schedules');
    const body = parse(shiftUpdateRequest, req.body);
    return withTx(pool, (tx) => sched.updateShift(tx, a, idOf(req), body, req.id));
  });
  app.delete('/v1/admin/shifts/:id', user, async (req: IdReq) => {
    const a = await admin(req, 'schedules');
    return withTx(pool, (tx) => sched.removeShift(deps, tx, a, idOf(req), req.id));
  });
  app.get<{ Querystring: { from?: string; to?: string; user_id?: string } }>('/v1/admin/shift-overrides', user, async (req) => {
    const a = await admin(req, 'schedules');
    const r = sched.parseDateRange(req.query, 400);
    return { items: await sched.listOverrides(pool, a.organizationId, { ...r, userId: optionalUuid(req.query.user_id) }) };
  });
  app.post('/v1/admin/shift-overrides', user, async (req, reply) => {
    const a = await admin(req, 'schedules');
    const body = parse(shiftOverrideRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => sched.upsertOverride(tx, a, body, req.id)));
  });
  app.delete('/v1/admin/shift-overrides/:id', user, async (req: IdReq) => {
    const a = await admin(req, 'schedules');
    await withTx(pool, (tx) => sched.deleteOverride(tx, a, idOf(req), req.id));
    return { ok: true };
  });
  // Attendance for anyone in the organization, for admins (audited like other views of a person's time).
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/v1/admin/users/:id/attendance', user, async (req) => {
    const a = await admin(req, 'schedules');
    const target = idOf(req);
    await assertSameOrgUser(pool, a, target);
    const r = await sched.attendanceFor(deps, pool, a.organizationId, target, sched.parseDateRange(req.query));
    if (target !== a.userId) {
      await audit(pool, { organizationId: a.organizationId, actor: a, action: 'attendance.view', targetType: 'user', targetId: target, targetUserId: target, requestId: req.id });
    }
    return r;
  });

  // ───────── admin: holidays ─────────
  app.get<{ Querystring: { year?: string } }>('/v1/admin/holidays', user, async (req) => {
    const a = await admin(req, 'schedules', 'time_off');
    const year = req.query.year ? parse(z.string().regex(/^\d{4}$/), req.query.year) : undefined;
    return { items: await sched.listHolidays(pool, a.organizationId, year) };
  });
  app.post('/v1/admin/holidays', user, async (req, reply) => {
    const a = await admin(req, 'schedules', 'time_off');
    const body = parse(holidayCreateRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => sched.createHoliday(tx, a, body, req.id)));
  });
  app.delete('/v1/admin/holidays/:id', user, async (req: IdReq) => {
    const a = await admin(req, 'schedules', 'time_off');
    await withTx(pool, (tx) => sched.deleteHoliday(tx, a, idOf(req), req.id));
    return { ok: true };
  });

  // ───────── admin: time-off policies, assignments, adjustments ─────────
  app.get('/v1/admin/time-off/policies', user, async (req) => ({ items: await off.listPolicies(pool, (await admin(req, 'time_off')).organizationId) }));
  app.post('/v1/admin/time-off/policies', user, async (req, reply) => {
    const a = await admin(req, 'time_off');
    const body = parse(timeOffPolicyCreate, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => off.createPolicy(tx, a, body, req.id)));
  });
  app.patch('/v1/admin/time-off/policies/:id', user, async (req: IdReq) => {
    const a = await admin(req, 'time_off');
    const body = parse(timeOffPolicyUpdate, req.body);
    return withTx(pool, (tx) => off.updatePolicy(tx, a, idOf(req), body, req.id));
  });
  app.get<{ Querystring: { policy_id?: string; user_id?: string } }>('/v1/admin/time-off/assignments', user, async (req) => {
    const a = await admin(req, 'time_off');
    return { items: await off.listAssignments(pool, a.organizationId, { policyId: optionalUuid(req.query.policy_id), userId: optionalUuid(req.query.user_id) }) };
  });
  app.post('/v1/admin/time-off/assignments', user, async (req, reply) => {
    const a = await admin(req, 'time_off');
    const body = parse(timeOffAssignmentCreate, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => off.assignPolicy(tx, a, body, req.id)));
  });
  app.delete('/v1/admin/time-off/assignments/:id', user, async (req: IdReq) => {
    const a = await admin(req, 'time_off');
    await withTx(pool, (tx) => off.removeAssignment(tx, a, idOf(req), req.id));
    return { ok: true };
  });
  app.post('/v1/admin/time-off/adjustments', user, async (req, reply) => {
    const a = await admin(req, 'time_off');
    const body = parse(timeOffAdjustmentCreate, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => off.adjustBalance(deps, tx, a, body, req.id)));
  });
}
