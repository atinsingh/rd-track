import { deploymentKeyCreateRequest, emailCodeRequest, localeSetRequest, logoSetRequest, logoUploadRequest } from '@rd/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, requireRole } from '../http';
import { parse } from '../lib/validate';
import * as b from './branding/service';

/** G26 (P2): the organization's logo and language (G27), and deployment keys for MDM. */
export async function brandingRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const id = (req: FastifyRequest<{ Params: { id: string } }>) => parse(z.uuid(), req.params.id);

  app.get('/v1/admin/branding', user, async (req) => b.branding(deps, pool, requireRole(req, ADMIN_ROLES).organizationId));
  app.post('/v1/admin/branding/logo-uploads', user, async (req, reply) => {
    const a = requireRole(req, ADMIN_ROLES);
    const body = parse(logoUploadRequest, req.body);
    return reply.code(201).send(await b.logoUpload(deps, a, body.content_type));
  });
  app.put('/v1/admin/branding/logo', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    const { upload_id } = parse(logoSetRequest, req.body);
    return withTx(pool, (tx) => b.setLogo(deps, tx, a, upload_id, req.id));
  });
  app.put('/v1/admin/branding/locale', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    const { locale } = parse(localeSetRequest, req.body);
    return withTx(pool, (tx) => b.setOrgLocale(deps, tx, a, locale, req.id));
  });
  app.delete('/v1/admin/branding/logo', user, async (req) => withTx(pool, (tx) => b.removeLogo(deps, tx, requireRole(req, ADMIN_ROLES), req.id)));

  app.get('/v1/admin/deployment-keys', user, async (req) => ({ items: await b.listDeploymentKeys(deps, pool, requireRole(req, ADMIN_ROLES)) }));
  app.post('/v1/admin/deployment-keys', user, async (req, reply) => {
    const a = requireRole(req, ADMIN_ROLES);
    const { name } = parse(deploymentKeyCreateRequest, req.body);
    // The address managed computers use: this API's public address, as people's browsers reach it.
    const server = deps.config.webUrl;
    return reply.code(201).send(await withTx(pool, (tx) => b.createDeploymentKey(deps, tx, a, name, server, req.id)));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/deployment-keys/:id/revoke', user, async (req) =>
    withTx(pool, (tx) => b.revokeDeploymentKey(deps, tx, requireRole(req, ADMIN_ROLES), id(req), req.id)),
  );

  // A managed computer asks for a code by email. Same answer whether or not the person exists.
  app.post('/v1/devices/enrollment-requests', { config: { auth: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(emailCodeRequest, req.body);
    const email = await b.requestEnrollmentCode(deps, pool, body.deployment_key, body.email);
    if (email) await deps.email.send(email);
    return reply.code(202).send({ ok: true });
  });
}
