import { activityPercent, type ExportDTO } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { isAdmin } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { toCsv } from '../../lib/csv';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertCanView, managedTeamIds } from '../authz';
import { emitEvent } from '../webhooks/service';

/** RPT-04: exports are authorized like the matching report, audited, and expire after 24 h. */

const EXPIRY_MS = 24 * 3600_000;

interface ExportScope {
  user_ids: string[];
  from: string;
  to: string;
  team_id: string | null;
}

export async function createExport(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { kind: 'sessions' | 'activity_daily'; from: string; to: string; team_id?: string; user_id?: string },
  requestId?: string,
): Promise<ExportDTO> {
  if (new Date(input.to).getTime() - new Date(input.from).getTime() > 366 * 86_400_000) {
    throw errors.validation('Exports are limited to one year');
  }
  const purpose = input.kind === 'sessions' ? 'time' : 'activity';
  let userIds: string[];
  if (input.team_id) {
    const managed = await managedTeamIds(q, actor.userId);
    const teamOk = await one(q, 'SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2', [input.team_id, actor.organizationId]);
    if (!teamOk) throw errors.notFound('Team');
    // Org admins may export time records; activity detail stays with managers (system design §3).
    if (!managed.includes(input.team_id) && !(isAdmin(actor) && purpose === 'time')) throw errors.forbidden();
    userIds = (
      await many<{ user_id: string }>(q, 'SELECT user_id FROM team_memberships WHERE team_id = $1 AND valid_to IS NULL', [input.team_id])
    ).map((r) => r.user_id);
    if (!isAdmin(actor) || purpose !== 'time') {
      for (const uid of userIds) await assertCanView(deps, q, actor, uid, purpose, { requestId });
    }
  } else {
    const uid = input.user_id ?? actor.userId;
    await assertCanView(deps, q, actor, uid, purpose, { requestId });
    userIds = [uid];
  }
  const scope: ExportScope = { user_ids: userIds, from: input.from, to: input.to, team_id: input.team_id ?? null };
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO export_jobs (organization_id, requester_id, kind, scope) VALUES ($1, $2, $3, $4) RETURNING id`,
    [actor.organizationId, actor.userId, input.kind, scope],
  );
  await enqueue(q, 'export.generate', { export_id: r!.id }, { organizationId: actor.organizationId });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'export.create',
    targetType: 'export',
    targetId: r!.id,
    targetUserId: userIds.length === 1 ? userIds[0] : undefined,
    requestId,
    metadata: { kind: input.kind, users: userIds.length, from: input.from, to: input.to, team_id: input.team_id ?? null },
  });
  return getExport(deps, q, actor, r!.id);
}

export async function generateExport(deps: Deps, q: Queryable, exportId: string): Promise<void> {
  const job = await one<{ id: string; organization_id: string; kind: string; scope: ExportScope }>(
    q,
    `UPDATE export_jobs SET status = 'running' WHERE id = $1 AND status IN ('queued', 'running') RETURNING id, organization_id, kind, scope`,
    [exportId],
  );
  if (!job) return;
  const { user_ids, from, to } = job.scope;
  let csv: string;
  let count: number;
  if (job.kind === 'sessions') {
    const rows = await many<Record<string, unknown>>(
      q,
      `SELECT u.display_name, u.email, s.id, p.name AS project, t.name AS task, s.source, s.corrected, s.started_at, s.ended_at,
              CASE WHEN s.source = 'manual' THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::int
                   ELSE (SELECT COALESCE(sum(active_seconds + idle_seconds), 0) FROM activity_buckets b WHERE b.session_id = s.id)::int
              END AS tracked_seconds
       FROM work_sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.organization_id = $1 AND s.user_id = ANY($2::uuid[]) AND s.started_at >= $3 AND s.started_at < $4
       ORDER BY u.display_name, s.started_at`,
      [job.organization_id, user_ids, from, to],
    );
    count = rows.length;
    csv = toCsv(
      ['employee', 'email', 'session_id', 'project', 'task', 'source', 'corrected', 'started_at_utc', 'ended_at_utc', 'tracked_seconds'],
      rows.map((r) => [r.display_name, r.email, r.id, r.project, r.task, r.source, r.corrected, r.started_at, r.ended_at, r.tracked_seconds]),
    );
  } else {
    const rows = await many<{ display_name: string; day: string; active: number; idle: number; missing: number }>(
      q,
      `SELECT u.display_name, (b.bucket_start AT TIME ZONE u.timezone)::date::text AS day,
              sum(b.active_seconds) FILTER (WHERE b.data_quality <> 'permission_missing')::int AS active,
              sum(b.idle_seconds) FILTER (WHERE b.data_quality <> 'permission_missing')::int AS idle,
              count(*) FILTER (WHERE b.data_quality = 'permission_missing')::int AS missing
       FROM activity_buckets b JOIN users u ON u.id = b.user_id
       WHERE b.organization_id = $1 AND b.user_id = ANY($2::uuid[]) AND b.bucket_start >= $3 AND b.bucket_start < $4
       GROUP BY u.display_name, day ORDER BY u.display_name, day`,
      [job.organization_id, user_ids, from, to],
    );
    count = rows.length;
    csv = toCsv(
      ['employee', 'date', 'active_seconds', 'idle_seconds', 'computer_activity_percent', 'minutes_without_permission'],
      rows.map((r) => [r.display_name, r.day, r.active ?? 0, r.idle ?? 0, activityPercent(r.active ?? 0, r.idle ?? 0), r.missing]),
    );
  }
  const key = `exports/${job.organization_id}/${job.id}.csv`;
  await deps.store.put(key, csv, 'text/csv; charset=utf-8');
  await q.query(
    `UPDATE export_jobs SET status = 'ready', object_key = $2, row_count = $3, completed_at = now(), expires_at = $4 WHERE id = $1`,
    [job.id, key, count, new Date(deps.now().getTime() + EXPIRY_MS).toISOString()],
  );
  await emitEvent(q, job.organization_id, 'export.ready', { export_id: job.id, kind: job.kind, rows: count });
}

export async function getExport(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<ExportDTO> {
  const e = await one<ExportDTO & { object_key: string | null }>(
    q,
    `SELECT id, kind, status, row_count, created_at, expires_at, object_key,
            scope->>'from' AS "from", scope->>'to' AS "to", scope->>'team_id' AS team_id,
            jsonb_array_length(scope->'user_ids') AS user_count
     FROM export_jobs
     WHERE id = $1 AND organization_id = $2 AND requester_id = $3`,
    [id, actor.organizationId, actor.userId],
  );
  if (!e) throw errors.notFound('Export');
  const expired = e.expires_at !== null && new Date(e.expires_at) <= deps.now();
  let download_url: string | null = null;
  if (e.status === 'ready' && !expired && e.object_key) {
    download_url = await deps.store.presignGet(e.object_key, 300, `rd-track-${e.kind}-${e.id.slice(0, 8)}.csv`);
    if (requestId) {
      await audit(q, { organizationId: actor.organizationId, actor, action: 'export.download_url', targetType: 'export', targetId: id, requestId });
    }
  }
  const { object_key: _k, ...dto } = e;
  return { ...dto, status: expired ? 'expired' : dto.status, download_url };
}

export async function listExports(deps: Deps, q: Queryable, actor: UserActor): Promise<ExportDTO[]> {
  const ids = await many<{ id: string }>(
    q,
    `SELECT id FROM export_jobs WHERE organization_id = $1 AND requester_id = $2 ORDER BY created_at DESC LIMIT 50`,
    [actor.organizationId, actor.userId],
  );
  return Promise.all(ids.map((r) => getExport(deps, q, actor, r.id)));
}
