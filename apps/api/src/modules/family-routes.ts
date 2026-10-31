import { childCreate, childUpdate, familyRulesPut } from '@rd/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { deviceOf, userOf } from '../http';
import { parse } from '../lib/validate';
import * as f from './family/service';

/**
 * Family (docs/design/08-family-plan.md, phase 1): parents manage children, rules and see today.
 * Every route is for a family's parents (org_admin): others get 403 `not_family` or forbidden.
 */
export async function familyRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const id = (req: FastifyRequest<{ Params: { id: string } }>) => parse(z.object({ id: z.string().max(64) }), req.params).id;

  app.get('/v1/family/children', user, async (req) => ({ items: await f.listChildren(deps, pool, userOf(req)) }));
  app.post('/v1/family/children', user, async (req, reply) => {
    const body = parse(childCreate, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => f.createChild(deps, tx, userOf(req), body, req.id)));
  });
  app.get<{ Params: { id: string } }>('/v1/family/children/:id', user, async (req) => f.getChild(deps, pool, userOf(req), id(req)));
  app.patch<{ Params: { id: string } }>('/v1/family/children/:id', user, async (req) => {
    const body = parse(childUpdate, req.body);
    return withTx(pool, (tx) => f.updateChild(deps, tx, userOf(req), id(req), body, req.id));
  });
  app.delete<{ Params: { id: string } }>('/v1/family/children/:id', user, async (req) =>
    withTx(pool, (tx) => f.removeChild(deps, tx, userOf(req), id(req), req.id)),
  );

  app.get('/v1/family/rules', user, async (req) => f.getRules(pool, userOf(req), null, req.headers['accept-language']));
  app.put('/v1/family/rules', user, async (req) => {
    const { rules } = parse(familyRulesPut, req.body);
    return withTx(pool, (tx) => f.putRules(deps, tx, userOf(req), null, rules, req.id, req.headers['accept-language']));
  });
  app.get<{ Params: { id: string } }>('/v1/family/children/:id/rules', user, async (req) =>
    f.getRules(pool, userOf(req), id(req), req.headers['accept-language']),
  );
  app.put<{ Params: { id: string } }>('/v1/family/children/:id/rules', user, async (req) => {
    const { rules } = parse(familyRulesPut, req.body);
    return withTx(pool, (tx) => f.putRules(deps, tx, userOf(req), id(req), rules, req.id, req.headers['accept-language']));
  });
  app.get<{ Params: { id: string } }>('/v1/family/children/:id/today', user, async (req) => f.childToday(deps, pool, userOf(req), id(req)));
  app.get<{ Params: { id: string } }>('/v1/family/children/:id/transparency', user, async (req) =>
    f.transparency(deps, pool, userOf(req), id(req), req.headers['accept-language']),
  );

  // The child's computer: its rules, signed like its policy. 404 for anyone but a child.
  app.get('/v1/device/family-rules', { config: { auth: 'device' } }, async (req) => f.signedRulesForDevice(deps, pool, deviceOf(req)));
}
