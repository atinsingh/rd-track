import { appCategoryRequest, webhookCreateRequest } from '@rd/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, requireRole, userOf } from '../http';
import { errors } from '../lib/errors';
import { parse, parseRange } from '../lib/validate';
import { managedTeamIds } from './authz';
import { assertEntitlement } from './billing/service';
import { deleteCategory, listCategories, personalInsights, setCategory, teamInsights } from './insights/service';
import { createEndpoint, deleteEndpoint, emitEvent, listDeliveries, listEndpoints } from './webhooks/service';

type RangeReq = FastifyRequest<{ Querystring: { from?: string; to?: string; tz?: string } }>;

function timeZone(v: string | undefined): string {
  if (!v) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return v;
  } catch {
    throw errors.validation('Unknown time zone');
  }
}

/** Stage 3: insights, work-app categories and outbound webhooks. */
export async function insightsRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };

  // Personal insights are on every plan: wellbeing is never an upsell.
  app.get('/v1/me/insights', user, async (req: RangeReq) => {
    const a = userOf(req);
    return personalInsights(pool, a.organizationId, a.userId, parseRange(req.query), timeZone(req.query.tz));
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; tz?: string } }>(
    '/v1/teams/:id/insights',
    user,
    async (req) => {
      const a = userOf(req);
      if (!(await managedTeamIds(pool, a.userId)).includes(req.params.id)) throw errors.forbidden();
      await assertEntitlement(pool, a.organizationId, 'team_insights', deps.now(), 'Team insights');
      return teamInsights(deps, pool, a, req.params.id, parseRange(req.query), timeZone(req.query.tz), req.id);
    },
  );

  // ───────── work-app categories ─────────
  app.get('/v1/admin/app-categories', user, async (req) => ({
    items: await listCategories(pool, requireRole(req, ADMIN_ROLES).organizationId),
  }));
  app.put('/v1/admin/app-categories', user, async (req) => {
    const body = parse(appCategoryRequest, req.body);
    return withTx(pool, (tx) => setCategory(tx, requireRole(req, ADMIN_ROLES), body, req.id));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/app-categories/:id', user, async (req) => {
    await withTx(pool, (tx) => deleteCategory(tx, requireRole(req, ADMIN_ROLES), req.params.id, req.id));
    return { ok: true };
  });

  // ───────── webhooks ─────────
  const webhookAdmin = async (req: FastifyRequest) => {
    const a = requireRole(req, ADMIN_ROLES);
    await assertEntitlement(pool, a.organizationId, 'webhooks', deps.now(), 'Webhooks');
    return a;
  };
  app.get('/v1/admin/webhooks', user, async (req) => ({ items: await listEndpoints(pool, (await webhookAdmin(req)).organizationId) }));
  app.post('/v1/admin/webhooks', user, async (req, reply) => {
    const a = await webhookAdmin(req);
    const body = parse(webhookCreateRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => createEndpoint(deps, tx, a, body, req.id)));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/webhooks/:id', user, async (req) => {
    const a = await webhookAdmin(req);
    await withTx(pool, (tx) => deleteEndpoint(tx, a, req.params.id, req.id));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/v1/admin/webhooks/:id/test', user, async (req) => {
    const a = await webhookAdmin(req);
    const n = await withTx(pool, (tx) => emitEvent(tx, a.organizationId, 'webhook.test', { message: 'Test delivery from RoundDigital Track' }, req.params.id));
    if (n === 0) throw errors.notFound('Webhook');
    return { queued: true };
  });
  app.get<{ Params: { id: string } }>('/v1/admin/webhooks/:id/deliveries', user, async (req) => {
    const a = await webhookAdmin(req);
    return { items: await listDeliveries(pool, a.organizationId, req.params.id) };
  });
}
