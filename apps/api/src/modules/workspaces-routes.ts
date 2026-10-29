import { AUDIT_EXPORT_MAX_ROWS, auditQuery, type AdminOverview, type AuditPerson, type MoneyOverview } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context';
import { ADMIN_ROLES, AUDIT_ROLES, MONEY_ROLES, requireRole } from '../http';
import { toCsv } from '../lib/csv';
import { parse } from '../lib/validate';
import { audit, listAudit } from './audit/service';
import { adminOverview, auditPeople, moneyOverview } from './engine/workspaces';
import { assertMoneyPlan } from './money/time';

/** Engine slice 4: what each role's home is built from, and the auditor's tools (G16, G20–G24). */
export async function workspacesRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };

  app.get('/v1/admin/overview', user, async (req): Promise<AdminOverview> => adminOverview(deps, pool, requireRole(req, ADMIN_ROLES)));

  app.get('/v1/money/overview', user, async (req): Promise<MoneyOverview> => {
    const a = requireRole(req, MONEY_ROLES);
    await assertMoneyPlan(deps, pool, a.organizationId);
    return moneyOverview(deps, pool, a);
  });

  // ───────── audit ─────────
  app.get('/v1/audit-events', user, async (req) => {
    const a = requireRole(req, AUDIT_ROLES);
    const qs = parse(auditQuery, req.query);
    return listAudit(pool, a.organizationId, { ...qs, actorId: qs.actor_id, subjectId: qs.subject_id });
  });
  app.get('/v1/audit-events/people', user, async (req): Promise<{ items: AuditPerson[] }> => ({
    items: await auditPeople(pool, requireRole(req, AUDIT_ROLES).organizationId),
  }));
  /** The filtered log as CSV, newest first. Exporting is itself audited. */
  app.get('/v1/audit-events/export', user, async (req, reply) => {
    const a = requireRole(req, AUDIT_ROLES);
    const { cursor: _cursor, ...qs } = parse(auditQuery, req.query);
    const page = await listAudit(pool, a.organizationId, { ...qs, actorId: qs.actor_id, subjectId: qs.subject_id, limit: AUDIT_EXPORT_MAX_ROWS }, AUDIT_EXPORT_MAX_ROWS);
    await audit(pool, {
      organizationId: a.organizationId,
      actor: a,
      action: 'audit.export',
      targetType: 'organization',
      targetId: a.organizationId,
      requestId: req.id,
      metadata: { rows: page.items.length, truncated: page.next_cursor !== null, filters: qs },
    });
    const csv = toCsv(
      ['time_utc', 'actor_type', 'actor', 'actor_id', 'action', 'target_type', 'target_id', 'about_user_id', 'result', 'request_id'],
      page.items.map((e) => [
        new Date(e.created_at).toISOString(),
        e.actor_type,
        e.actor_name,
        e.actor_id,
        e.action,
        e.target_type,
        e.target_id,
        e.target_user_id,
        e.result,
        e.request_id,
      ]),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-log.csv"`)
      .header('x-rd-truncated', page.next_cursor !== null ? '1' : '0')
      .send(csv);
  });
}
