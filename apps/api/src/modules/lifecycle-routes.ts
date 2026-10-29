import { closeOrganizationRequest, type DataExportDTO, type DeletionCertificateDTO, type OrganizationLifecycle } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, platformOf, requireRole } from '../http';
import { errors } from '../lib/errors';
import { parse } from '../lib/validate';
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

  // Operators: what was deleted, kept after the organization is gone.
  app.get('/platform/v1/deletion-certificates', { config: { auth: 'platform' as const } }, async (req): Promise<{ items: DeletionCertificateDTO[] }> => {
    if (!platformOf(req).mfaVerified) throw errors.mfaRequired();
    return { items: await listCertificates(pool) };
  });
}
