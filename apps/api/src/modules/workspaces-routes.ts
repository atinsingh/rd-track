import {
  agentUpdateSettingsRequest,
  AUDIT_EXPORT_MAX_ROWS,
  auditQuery,
  type AdminOverview,
  type AgentDownloadsResponse,
  type AuditPerson,
  type DeviceDTO,
  type EnrollmentCodeResponse,
  type MoneyOverview,
  type SupportGrantDTO,
} from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, AUDIT_ROLES, MONEY_ROLES, requireRole, userOf } from '../http';
import { toCsv } from '../lib/csv';
import { parse } from '../lib/validate';
import { audit, listAudit } from './audit/service';
import { createEnrollmentCode, listDevices } from './devices/service';
import { setUpdateMode, updateSettings } from './devices/updates';
import { adminOverview, auditPeople, moneyOverview } from './engine/workspaces';
import { assertMoneyPlan } from './money/time';
import { decideGrant, endGrant, listGrants } from './platform/support';
import { lang, langOfUser, SERVER_DEFAULT_LOCALE, type Lang } from '../i18n';

/**
 * Installer links for the published agent version (G10). File names are the Tauri bundler's,
 * as GitHub release assets store them (spaces become dots); a CDN mirrors the same names.
 */
export function agentDownloads(
  c: Config['agentDownloads'],
  l: Lang = lang(SERVER_DEFAULT_LOCALE),
  ext: Config['browserExtensions'] = { chrome: null, edge: null, firefox: null },
): AgentDownloadsResponse {
  const extensions = (['chrome', 'edge', 'firefox'] as const).flatMap((browser) => (ext[browser] ? [{ browser, url: ext[browser]! }] : []));
  if (!c.baseUrl || !c.version) return { available: false, version: null, files: [], extensions };
  const file = (name: string) => `${c.baseUrl}/${encodeURIComponent(`RoundDigital.Track_${c.version}_${name}`)}`;
  return {
    available: true,
    version: c.version,
    files: [
      { os: 'macos', label: l.t('download.mac.label'), kind: l.t('download.mac.kind'), url: file('universal.dmg') },
      { os: 'windows', label: l.t('download.win.label'), kind: l.t('download.win.kind'), url: file('x64-setup.exe') },
      { os: 'windows', label: l.t('download.msi.label'), kind: l.t('download.msi.kind'), url: file('x64_en-US.msi') },
    ],
    extensions,
  };
}

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

  // ───────── support access the tenant approves (G2) ─────────
  app.get('/v1/admin/support-grants', user, async (req): Promise<{ items: SupportGrantDTO[] }> => ({
    items: await listGrants(deps, pool, { orgId: requireRole(req, ADMIN_ROLES).organizationId }),
  }));
  app.post<{ Params: { id: string } }>('/v1/admin/support-grants/:id/approve', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    return withTx(pool, (tx) => decideGrant(deps, tx, a, parse(z.uuid(), req.params.id), true, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/support-grants/:id/deny', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    return withTx(pool, (tx) => decideGrant(deps, tx, a, parse(z.uuid(), req.params.id), false, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/support-grants/:id/end', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    return withTx(pool, (tx) => endGrant(deps, tx, { actor: a, side: 'tenant' }, parse(z.uuid(), req.params.id), req.id));
  });

  // ───────── getting the agent (G10, G12) ─────────
  app.get('/v1/agent/downloads', user, async (req): Promise<AgentDownloadsResponse> => agentDownloads(deps.config.agentDownloads, await langOfUser(pool, userOf(req).userId), deps.config.browserExtensions));
  app.get('/v1/admin/agent-updates', user, async (req) => updateSettings(deps.config.agentDownloads, pool, requireRole(req, ADMIN_ROLES).organizationId));
  app.put('/v1/admin/agent-updates', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    const { mode } = parse(agentUpdateSettingsRequest, req.body);
    return withTx(pool, (tx) => setUpdateMode(deps.config.agentDownloads, tx, a, mode, req.id));
  });
  app.get('/v1/me/devices', user, async (req): Promise<{ items: DeviceDTO[] }> => {
    const a = userOf(req);
    return { items: await listDevices(pool, a.organizationId, a.userId) };
  });
  /** Self-enrolment: anyone who tracks gets a code for their own computer, without asking an admin. */
  app.post('/v1/me/enrollment-code', user, async (req, reply): Promise<EnrollmentCodeResponse> => {
    const a = userOf(req);
    return reply.code(201).send(await withTx(pool, (tx) => createEnrollmentCode(deps, tx, a, a.userId, req.id)));
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
