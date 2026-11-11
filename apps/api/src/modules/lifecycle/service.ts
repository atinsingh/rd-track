import { createHash } from 'node:crypto';
import {
  BACKUP_RETENTION_DAYS,
  CLOSE_GRACE_DAYS,
  DATA_EXPORT_HOURS,
  type DataExportDTO,
  type DeletionCertificateDTO,
  type OrganizationLifecycle,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { errors } from '../../lib/errors';
import { zip } from '../../lib/zip';
import { audit } from '../audit/service';
import { notify } from '../engine/notify';
import { orgAdmins } from '../engine/events';
import { personFiles } from './person';
import { tableCsv } from './tables';
import type { Lang } from '../../i18n';

/**
 * Data lifecycle (slice 5b, G17): an organization's own export, closing it, and the
 * deletion certificate that outlives it. Activity, app names and screenshots are not in
 * the organization export, because admins can't see them in Track either; each person
 * downloads their own (5c).
 */

/** What the organization export contains, table by table, minus secrets. */
const ORG_TABLES: { table: string; drop?: string[] }[] = [
  { table: 'users', drop: ['password_hash', 'mfa_secret_enc'] },
  { table: 'teams' },
  { table: 'team_memberships' },
  { table: 'projects' },
  { table: 'tasks' },
  { table: 'project_memberships' },
  { table: 'work_sessions' },
  { table: 'session_transitions' },
  { table: 'time_corrections' },
  { table: 'timesheets' },
  { table: 'timesheet_events' },
  { table: 'work_limits' },
  { table: 'time_off_policies' },
  { table: 'time_off_assignments' },
  { table: 'time_off_ledger' },
  { table: 'time_off_requests' },
  { table: 'holidays' },
  { table: 'shifts' },
  { table: 'shift_overrides' },
  { table: 'clients' },
  { table: 'client_contacts', drop: ['password_hash', 'link_token_hash'] },
  { table: 'deployment_keys', drop: ['key_hash'] },
  { table: 'pay_rates' },
  { table: 'bill_rates' },
  { table: 'project_budgets' },
  { table: 'invoices' },
  { table: 'invoice_lines' },
  { table: 'expenses', drop: ['receipt_key'] },
  { table: 'payroll_adjustments' },
  { table: 'policies' },
  { table: 'policy_versions' },
  { table: 'app_categories' },
  { table: 'devices', drop: ['credential_hash'] },
  { table: 'legal_holds' },
  { table: 'deletion_requests' },
  { table: 'support_access_grants' },
  { table: 'audit_logs' },
];

// ───────────── exports ─────────────

const SELECT_EXPORT = `SELECT id, kind, subject_user_id, status, size_bytes, file_count, created_at, completed_at, expires_at, object_key FROM data_exports`;

async function toDto(deps: Deps, row: Omit<DataExportDTO, 'download_url'> & { object_key: string | null }, filename: string): Promise<DataExportDTO> {
  const { object_key, ...rest } = row;
  const expired = rest.status === 'ready' && rest.expires_at !== null && Date.parse(rest.expires_at) <= deps.now().getTime();
  return {
    ...rest,
    status: expired ? 'expired' : rest.status,
    download_url: rest.status === 'ready' && !expired && object_key ? await deps.store.presignGet(object_key, 300, filename) : null,
  };
}

export async function requestDataExport(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  kind: 'organization' | 'person',
  requestId?: string,
): Promise<DataExportDTO> {
  const running = await one(
    q,
    `SELECT 1 FROM data_exports WHERE organization_id = $1 AND requested_by = $2 AND kind = $3 AND status IN ('queued', 'running')`,
    [actor.organizationId, actor.userId, kind],
  );
  if (running) throw errors.conflict('export_in_progress', 'An export is already being prepared');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO data_exports (organization_id, kind, subject_user_id, requested_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [actor.organizationId, kind, kind === 'person' ? actor.userId : null, actor.userId],
  );
  await enqueue(q, 'data_export.generate', { data_export_id: r!.id }, { organizationId: actor.organizationId });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: kind === 'organization' ? 'data_export.organization' : 'data_export.person',
    targetType: 'data_export',
    targetId: r!.id,
    targetUserId: kind === 'person' ? actor.userId : undefined,
    requestId,
  });
  return (await listDataExports(deps, q, actor, kind)).find((e) => e.id === r!.id)!;
}

export async function listDataExports(deps: Deps, q: Queryable, actor: UserActor, kind: 'organization' | 'person'): Promise<DataExportDTO[]> {
  const rows = await many<Omit<DataExportDTO, 'download_url'> & { object_key: string | null }>(
    q,
    `${SELECT_EXPORT} WHERE organization_id = $1 AND requested_by = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 20`,
    [actor.organizationId, actor.userId, kind],
  );
  const name = kind === 'organization' ? 'organization-export.zip' : 'my-data.zip';
  return Promise.all(rows.map((r) => toDto(deps, r, name)));
}

async function organizationFiles(deps: Deps, q: Queryable, orgId: string): Promise<{ name: string; data: Buffer | string }[]> {
  const org = await one<{ name: string; slug: string; region: string; created_at: string }>(q, 'SELECT name, slug, region, created_at FROM organizations WHERE id = $1', [orgId]);
  const sub = await one(q, 'SELECT plan, status, seats, billing_interval, trial_ends_at, current_period_end FROM subscriptions WHERE organization_id = $1', [orgId]);
  const files: { name: string; data: string }[] = [];
  const counts: Record<string, number> = {};
  for (const t of ORG_TABLES) {
    const { csv, rows } = await tableCsv(q, t.table, 'organization_id = $1', [orgId], t.drop);
    files.push({ name: `${t.table}.csv`, data: csv });
    counts[t.table] = rows;
  }
  const generated = deps.now().toISOString();
  files.unshift(
    {
      name: 'README.txt',
      data: [
        `${org!.name} — RoundDigital Track export`,
        `Generated ${generated} (UTC).`,
        '',
        'One CSV per kind of record, with the database column names. Times are UTC (ISO 8601).',
        'Included: people, teams, projects and tasks; work sessions and their pauses; corrections,',
        'timesheets, work limits, time off, holidays and shifts; clients, rates, budgets and invoices;',
        'collection policies and their history; computers (without credentials); legal holds,',
        'deletion requests, support access and the full audit log.',
        '',
        'Not included: computer activity, app names and screenshots. Admins cannot see those in',
        'Track either. Each person can download their own from My data.',
        'Never included: passwords, two-factor secrets, device credentials, sign-in tokens.',
        '',
        'Rows per file:',
        ...Object.entries(counts).map(([t, n]) => `  ${t}.csv  ${n}`),
      ].join('\n'),
    },
    { name: 'organization.json', data: JSON.stringify({ organization: { id: orgId, ...org }, subscription: sub, generated_at: generated }, null, 2) },
  );
  return files;
}

export async function generateDataExport(deps: Deps, q: Queryable, id: string): Promise<void> {
  const job = await one<{ id: string; organization_id: string; kind: 'organization' | 'person'; subject_user_id: string | null; requested_by: string }>(
    q,
    `UPDATE data_exports SET status = 'running' WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING id, organization_id, kind, subject_user_id, requested_by`,
    [id],
  );
  if (!job) return;
  const files =
    job.kind === 'organization'
      ? await organizationFiles(deps, q, job.organization_id)
      : await personFiles(deps, q, job.organization_id, job.subject_user_id!);
  const body = zip(files, deps.now());
  const key = `data-exports/${job.organization_id}/${job.id}.zip`;
  await deps.store.put(key, body, 'application/zip');
  await q.query(
    `UPDATE data_exports SET status = 'ready', object_key = $2, size_bytes = $3, file_count = $4, completed_at = $5, expires_at = $6 WHERE id = $1`,
    [job.id, key, body.length, files.length, deps.now().toISOString(), new Date(deps.now().getTime() + DATA_EXPORT_HOURS * 3600_000).toISOString()],
  );
  const link = job.kind === 'organization' ? '/admin/data' : '/me/privacy';
  await notify(q, job.organization_id, [job.requested_by], {
    kind: 'data_export_ready',
    category: 'my_requests',
    title: (l) => (job.kind === 'organization' ? l.t('export.orgReady') : l.t('export.mineReady')),
    body: (l) => l.t('export.body', { n: DATA_EXPORT_HOURS }),
    link,
  });
}

// ───────────── closing an organization ─────────────

export async function lifecycle(q: Queryable, orgId: string): Promise<OrganizationLifecycle> {
  return (await one<OrganizationLifecycle>(
    q,
    `SELECT o.name, o.deletion_scheduled_at, o.deletion_requested_at, u.display_name AS deletion_requested_by_name
     FROM organizations o LEFT JOIN users u ON u.id = o.deletion_requested_by WHERE o.id = $1`,
    [orgId],
  ))!;
}

/** Schedules deletion CLOSE_GRACE_DAYS ahead. The exact organization name must be typed. */
export async function scheduleClose(deps: Deps, q: Queryable, actor: UserActor, confirmName: string, requestId?: string): Promise<OrganizationLifecycle> {
  const org = await lifecycle(q, actor.organizationId);
  if (confirmName.trim() !== org.name) throw errors.validation('Type the organization name exactly as shown to confirm');
  if (org.deletion_scheduled_at) throw errors.conflict('already_closing', 'This organization is already scheduled for deletion');
  const now = deps.now();
  const at = new Date(now.getTime() + CLOSE_GRACE_DAYS * 86_400_000).toISOString();
  await q.query(`UPDATE organizations SET deletion_scheduled_at = $2, deletion_requested_at = $3, deletion_requested_by = $4 WHERE id = $1`, [
    actor.organizationId,
    at,
    now.toISOString(),
    actor.userId,
  ]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'organization.close_scheduled', targetType: 'organization', targetId: actor.organizationId, requestId, metadata: { delete_at: at } });
  await notify(q, actor.organizationId, await orgAdmins(q, actor.organizationId), {
    kind: 'organization_closing',
    category: 'security',
    title: (l) => l.t('closing.admins.title', { org: org.name, date: day(l, at) }),
    body: (l) => l.t(actor.orgRole === 'super_admin' ? 'closing.admins.body.super' : 'closing.admins.body.org'),
    link: '/admin/data',
  });
  // Everyone else's data goes too, so they hear about it and can download their own first.
  const admins = new Set(await orgAdmins(q, actor.organizationId));
  const everyone = (await many<{ id: string }>(q, `SELECT id FROM users WHERE organization_id = $1 AND status = 'active'`, [actor.organizationId]))
    .map((u) => u.id)
    .filter((id) => !admins.has(id));
  await notify(q, actor.organizationId, everyone, {
    kind: 'organization_closing',
    category: 'privacy',
    title: (l) => l.t('closing.everyone.title', { org: org.name, date: day(l, at) }),
    body: (l) => l.t('closing.everyone.body'),
    link: '/me/privacy',
  });
  return lifecycle(q, actor.organizationId);
}

export async function cancelClose(deps: Deps, q: Queryable, actor: UserActor, requestId?: string): Promise<OrganizationLifecycle> {
  const org = await lifecycle(q, actor.organizationId);
  if (!org.deletion_scheduled_at) throw errors.conflict('not_closing', 'This organization is not scheduled for deletion');
  await q.query(`UPDATE organizations SET deletion_scheduled_at = NULL, deletion_requested_at = NULL, deletion_requested_by = NULL WHERE id = $1`, [actor.organizationId]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'organization.close_cancelled', targetType: 'organization', targetId: actor.organizationId, requestId });
  await notify(q, actor.organizationId, await orgAdmins(q, actor.organizationId), {
    kind: 'organization_closing_cancelled',
    category: 'security',
    title: (l) => l.t('closing.cancelled.title', { org: org.name }),
    body: (l) => l.t('closing.cancelled.body'),
    link: '/admin/data',
  });
  return lifecycle(q, actor.organizationId);
}

const day = (l: Lang, iso: string) => new Intl.DateTimeFormat(l.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

/** The certificate's canonical text; its SHA-256 is the digest. */
export function certificateText(c: Omit<DeletionCertificateDTO, 'id' | 'digest'>): string {
  return [
    'RoundDigital Track — certificate of deletion',
    `Organization: ${c.organization_name} (${c.organization_slug}, ${c.organization_id})`,
    `Closing requested: ${c.requested_at ?? 'by RoundDigital'}${c.requested_by_email ? ` by ${c.requested_by_email}` : ''}`,
    `Deleted: ${c.deleted_at}`,
    `Stored files deleted: ${c.objects_deleted}`,
    'Records deleted:',
    ...Object.entries(c.rows_deleted)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, n]) => `  ${t}: ${n}`),
    `Encrypted backups containing this data expire by: ${c.backups_expire_by}`,
  ].join('\n');
}

/**
 * Deletes everything an organization owns: stored files first (screenshots, exports),
 * then its rows (one cascade from `organizations`, audit log included), and writes the
 * certificate. Returns the certificate and who to send it to.
 */
export async function purgeOrganization(deps: Deps, q: Queryable, orgId: string): Promise<{ certificate: DeletionCertificateDTO; recipients: string[] }> {
  const org = await one<{ name: string; slug: string; deletion_requested_at: string | null; requested_by_email: string | null }>(
    q,
    `SELECT o.name, o.slug, o.deletion_requested_at, u.email AS requested_by_email
     FROM organizations o LEFT JOIN users u ON u.id = o.deletion_requested_by WHERE o.id = $1 FOR UPDATE OF o`,
    [orgId],
  );
  if (!org) throw errors.notFound('Organization');
  const recipients = (
    await many<{ email: string }>(q, `SELECT email FROM users WHERE organization_id = $1 AND status = 'active' AND org_role IN ('org_admin', 'super_admin')`, [orgId])
  ).map((r) => r.email);
  const tables = (
    await many<{ table_name: string }>(
      q,
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'organization_id' AND table_name NOT IN ('deletion_certificates', 'signup_requests')
       ORDER BY table_name`,
    )
  ).map((r) => r.table_name);
  const rows: Record<string, number> = { organizations: 1 };
  for (const t of tables) {
    const n = (await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [orgId]))!.n;
    if (n) rows[t] = n;
  }
  const keys = (
    await many<{ key: string }>(
      q,
      `SELECT object_key AS key FROM screenshots WHERE organization_id = $1 AND object_key IS NOT NULL
       UNION ALL SELECT object_key FROM export_jobs WHERE organization_id = $1 AND object_key IS NOT NULL
       UNION ALL SELECT object_key FROM payroll_exports WHERE organization_id = $1 AND object_key IS NOT NULL
       UNION ALL SELECT object_key FROM data_exports WHERE organization_id = $1 AND object_key IS NOT NULL
       UNION ALL SELECT receipt_key FROM expenses WHERE organization_id = $1 AND receipt_key IS NOT NULL
       UNION ALL SELECT logo_key FROM organizations WHERE id = $1 AND logo_key IS NOT NULL`,
      [orgId],
    )
  ).map((r) => r.key);
  for (const k of keys) await deps.store.delete(k);
  // The audit log is append-only; deleting the whole organization is the one exception.
  await q.query(`SELECT set_config('rd.allow_audit_purge', 'on', true)`);
  await q.query('DELETE FROM organizations WHERE id = $1', [orgId]);
  await q.query(`SELECT set_config('rd.allow_audit_purge', 'off', true)`);
  const deletedAt = deps.now();
  const body: Omit<DeletionCertificateDTO, 'id' | 'digest'> = {
    organization_id: orgId,
    organization_name: org.name,
    organization_slug: org.slug,
    requested_by_email: org.requested_by_email,
    requested_at: org.deletion_requested_at,
    deleted_at: deletedAt.toISOString(),
    rows_deleted: rows,
    objects_deleted: keys.length,
    backups_expire_by: new Date(deletedAt.getTime() + BACKUP_RETENTION_DAYS * 86_400_000).toISOString(),
  };
  const digest = createHash('sha256').update(certificateText(body)).digest('hex');
  const c = await one<{ id: string }>(
    q,
    `INSERT INTO deletion_certificates (organization_id, organization_name, organization_slug, requested_by_email, requested_at, deleted_at, rows_deleted, objects_deleted, backups_expire_by, digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [orgId, org.name, org.slug, org.requested_by_email, org.deletion_requested_at, body.deleted_at, rows, keys.length, body.backups_expire_by, digest],
  );
  return { certificate: { id: c!.id, ...body, digest }, recipients: [...new Set([...recipients, ...(org.requested_by_email ? [org.requested_by_email] : [])])] };
}

export async function listCertificates(q: Queryable): Promise<DeletionCertificateDTO[]> {
  return many<DeletionCertificateDTO>(
    q,
    `SELECT id, organization_id, organization_name, organization_slug, requested_by_email, requested_at, deleted_at, rows_deleted,
            objects_deleted, backups_expire_by, digest
     FROM deletion_certificates ORDER BY deleted_at DESC LIMIT 200`,
  );
}

/** Organizations whose closing date has come. */
export async function dueForDeletion(deps: Pick<Deps, 'now'>, q: Queryable): Promise<string[]> {
  return (
    await many<{ id: string }>(q, 'SELECT id FROM organizations WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= $1', [
      deps.now().toISOString(),
    ])
  ).map((r) => r.id);
}
