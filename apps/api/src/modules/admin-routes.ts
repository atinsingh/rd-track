import {
  SCOPE_TYPES,
  changePlanRequest,
  createProjectRequest,
  createTaskRequest,
  createTeamRequest,
  createUserRequest,
  enrollmentCodeRequest,
  policyUpdateRequest,
  projectMemberRequest,
  teamMemberRequest,
  updateUserRequest,
  type ScopeType,
} from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, AUDIT_ROLES, requireRole } from '../http';
import { errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { listAudit } from './audit/service';
import { changePlan, subscriptionDTO } from './billing/service';
import { createEnrollmentCode, listDevices, revokeDevice } from './devices/service';
import * as org from './org/service';
import { listPolicies, publishPolicy, scopeDetail } from './policy/service';
import { createLegalHold, listDeletionRequests, reviewDeletionRequest } from './privacy/service';

const legalHoldRequest = z.strictObject({
  user_id: z.uuid(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  reason: z.string().min(3).max(1000),
});

/** Organization administration, policies, billing and audit. Privileged roles require MFA (see app.ts). */
export async function adminRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const admin = (req: Parameters<typeof requireRole>[0]) => requireRole(req, ADMIN_ROLES);

  // ───────── users ─────────
  app.get('/v1/admin/users', user, async (req) => ({ items: await org.listUsers(pool, admin(req).organizationId) }));
  app.post('/v1/admin/users', user, async (req, reply) => {
    const body = parse(createUserRequest, req.body);
    const r = await withTx(pool, (tx) => org.createUser(deps, tx, admin(req), body, req.id));
    return reply.code(201).send(r);
  });
  app.patch<{ Params: { id: string } }>('/v1/admin/users/:id', user, async (req) => {
    const body = parse(updateUserRequest, req.body);
    return withTx(pool, (tx) => org.updateUser(deps, tx, admin(req), req.params.id, body, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/deactivate', user, async (req) =>
    withTx(pool, (tx) => org.deactivateUser(deps, tx, admin(req), req.params.id, req.id)),
  );

  // ───────── teams & projects ─────────
  app.get('/v1/admin/teams', user, async (req) => ({ items: await org.listTeams(pool, admin(req).organizationId) }));
  app.post('/v1/admin/teams', user, async (req, reply) => {
    const { name } = parse(createTeamRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => org.createTeam(tx, admin(req), name, req.id)));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/teams/:id/members', user, async (req) => {
    const body = parse(teamMemberRequest, req.body);
    await withTx(pool, (tx) => org.setTeamMember(tx, admin(req), req.params.id, body.user_id, body.role, req.id));
    return { ok: true };
  });
  app.delete<{ Params: { id: string; userId: string } }>('/v1/admin/teams/:id/members/:userId', user, async (req) => {
    await withTx(pool, (tx) => org.removeTeamMember(tx, admin(req), req.params.id, req.params.userId, req.id));
    return { ok: true };
  });
  app.get('/v1/admin/projects', user, async (req) => ({ items: await org.listProjects(pool, admin(req).organizationId) }));
  app.post('/v1/admin/projects', user, async (req, reply) => {
    const body = parse(createProjectRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => org.createProject(tx, admin(req), body.name, body.client_ref, req.id)));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/projects/:id/tasks', user, async (req, reply) => {
    const { name } = parse(createTaskRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => org.createTask(tx, admin(req), req.params.id, name, req.id)));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/projects/:id/members', user, async (req) => {
    const body = parse(projectMemberRequest, req.body);
    await withTx(pool, (tx) => org.setProjectMember(tx, admin(req), req.params.id, body.user_id, body.role, req.id));
    return { ok: true };
  });

  // ───────── devices ─────────
  app.post('/v1/admin/enrollment-codes', user, async (req, reply) => {
    const { user_id } = parse(enrollmentCodeRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => createEnrollmentCode(deps, tx, admin(req), user_id, req.id)));
  });
  app.get('/v1/admin/devices', user, async (req) => ({ items: await listDevices(pool, admin(req).organizationId) }));
  app.post<{ Params: { id: string } }>('/v1/admin/devices/:id/revoke', user, async (req) => {
    await withTx(pool, (tx) => revokeDevice(deps, tx, admin(req), req.params.id, req.id));
    return { ok: true };
  });

  // ───────── policies ─────────
  const scopeParams = z.object({ scope_type: z.enum(SCOPE_TYPES), scope_id: z.uuid() });
  app.get('/v1/policies', user, async (req) => listPolicies(pool, admin(req).organizationId));
  app.get('/v1/policies/:scope_type/:scope_id', user, async (req) => {
    const p = parse(scopeParams, req.params);
    return scopeDetail(deps, pool, admin(req).organizationId, p.scope_type as ScopeType, p.scope_id);
  });
  app.put('/v1/policies/:scope_type/:scope_id', user, async (req) => {
    const p = parse(scopeParams, req.params);
    const body = parse(policyUpdateRequest, req.body);
    return withTx(pool, (tx) => publishPolicy(deps, tx, admin(req), p.scope_type as ScopeType, p.scope_id, body, req.id));
  });

  // ───────── privacy requests ─────────
  app.get('/v1/admin/deletion-requests', user, async (req) => ({
    items: await listDeletionRequests(pool, admin(req).organizationId),
  }));
  for (const verb of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/admin/deletion-requests/:id/${verb}`, user, async (req) =>
      withTx(pool, (tx) => reviewDeletionRequest(tx, admin(req), req.params.id, verb === 'approve', req.id)),
    );
  }
  app.post('/v1/admin/legal-holds', user, async (req, reply) => {
    const body = parse(legalHoldRequest, req.body);
    if (new Date(body.to) <= new Date(body.from)) throw errors.validation('to must be after from');
    return reply.code(201).send(await withTx(pool, (tx) => createLegalHold(deps, tx, admin(req), body, req.id)));
  });

  // ───────── billing ─────────
  app.get('/v1/billing/subscription', user, async (req) => subscriptionDTO(pool, admin(req).organizationId, deps.now()));
  app.post('/v1/billing/plan', user, async (req) => {
    const body = parse(changePlanRequest, req.body);
    return withTx(pool, (tx) => changePlan(tx, admin(req), body, deps.now(), req.id));
  });

  // ───────── audit ─────────
  app.get<{ Querystring: { from?: string; to?: string; action?: string; actor_id?: string; cursor?: string } }>(
    '/v1/audit-events',
    user,
    async (req) => {
      const a = requireRole(req, AUDIT_ROLES);
      const qs = parse(
        z.object({
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          action: z.string().max(100).optional(),
          actor_id: z.uuid().optional(),
          cursor: z.string().regex(/^\d+$/).optional(),
        }),
        req.query,
      );
      return listAudit(pool, a.organizationId, { ...qs, actorId: qs.actor_id });
    },
  );
}
