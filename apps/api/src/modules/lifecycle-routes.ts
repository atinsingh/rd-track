import {
  closeOrganizationRequest,
  erasureDecision,
  erasureRequest,
  type DataExportDTO,
  type DeletionCertificateDTO,
  type ErasureRequestDTO,
  type OrganizationLifecycle,
} from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, platformOf, requireRole, userOf } from '../http';
import { errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { decideErasure, listErasureRequests, myErasureRequest, requestErasure } from './lifecycle/person';
import { cancelClose, lifecycle, listCertificates, listDataExports, requestDataExport, scheduleClose } from './lifecycle/service';

/** Slice 5b (G17): an organization's export, closing it, and certificates of deletion. */
export async function lifecycleRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const admin = (req: Parameters<typeof requireRole>[0]) => requireRole(req, ADMIN_ROLES);

  app.get('/v1/admin/organization', user, async (req): Promise<OrganizationLifecycle> => lifecycle(pool, admin(req).organizationId));
  app.post('/v1/admin/organization/close', user, async (req): Promise<OrganizationLifecycle> => {
    const a = admin(req);
    const { confirm_name } = parse(closeOrganizationRequest, req.body);
    return withTx(pool, (tx) => scheduleClose(deps, tx, a, confirm_name, req.id));
  });
  app.post('/v1/admin/organization/close/cancel', user, async (req): Promise<OrganizationLifecycle> => {
    const a = admin(req);
    return withTx(pool, (tx) => cancelClose(deps, tx, a, req.id));
  });

  app.get('/v1/admin/data-exports', user, async (req): Promise<{ items: DataExportDTO[] }> => ({
    items: await listDataExports(deps, pool, admin(req), 'organization'),
  }));
  app.post('/v1/admin/data-exports', user, async (req, reply) => {
    const a = admin(req);
    return reply.code(201).send(await withTx(pool, (tx) => requestDataExport(deps, tx, a, 'organization', req.id)));
  });

  // ───────── a person's own data (5c, G18) ─────────
  app.get('/v1/me/data-exports', user, async (req): Promise<{ items: DataExportDTO[] }> => ({
    items: await listDataExports(deps, pool, userOf(req), 'person'),
  }));
  app.post('/v1/me/data-exports', user, async (req, reply) => {
    const a = userOf(req);
    return reply.code(201).send(await withTx(pool, (tx) => requestDataExport(deps, tx, a, 'person', req.id)));
  });
  app.get('/v1/me/erasure-request', user, async (req): Promise<{ request: ErasureRequestDTO | null }> => ({ request: await myErasureRequest(pool, userOf(req)) }));
  app.post('/v1/me/erasure-request', user, async (req, reply) => {
    const a = userOf(req);
    const { reason } = parse(erasureRequest, req.body ?? {});
    return reply.code(201).send(await withTx(pool, (tx) => requestErasure(tx, a, reason, req.id)));
  });
  app.get('/v1/admin/erasure-requests', user, async (req): Promise<{ items: ErasureRequestDTO[] }> => ({
    items: await listErasureRequests(pool, admin(req).organizationId),
  }));
  app.post<{ Params: { id: string } }>('/v1/admin/erasure-requests/:id/approve', user, async (req) => {
    const a = admin(req);
    return withTx(pool, (tx) => decideErasure(deps, tx, a, parse(z.uuid(), req.params.id), true, undefined, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/erasure-requests/:id/decline', user, async (req) => {
    const a = admin(req);
    const { reason } = parse(erasureDecision, req.body);
    return withTx(pool, (tx) => decideErasure(deps, tx, a, parse(z.uuid(), req.params.id), false, reason, req.id));
  });

  // Operators: what was deleted, kept after the organization is gone.
  app.get('/platform/v1/deletion-certificates', { config: { auth: 'platform' as const } }, async (req): Promise<{ items: DeletionCertificateDTO[] }> => {
    if (!platformOf(req).mfaVerified) throw errors.mfaRequired();
    return { items: await listCertificates(pool) };
  });
}
