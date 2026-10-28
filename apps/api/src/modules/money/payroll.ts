import { billableHours, lineAmountCents, type PayrollExportDTO } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { toCsv } from '../../lib/csv';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertTimezone, dateRange, groupSeconds, timeWithPayRates, userTimezone } from './time';

/**
 * Payroll CSV for a pay period: one row per person and pay rate (hours × pay rate), built by
 * the `payroll.generate` worker job into object storage, downloadable by the requester for
 * 24 hours — the same pattern as RPT-04 exports. The file reveals pay rates, so each
 * download link issued writes a `pay_rate.view` audit entry for every person in the file.
 *
 * TODO(timesheets): use approved timesheet time only once timesheets land.
 */

const EXPIRY_MS = 24 * 3600_000;

export async function createPayrollExport(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { period_from: string; period_to: string; timezone?: string; user_ids?: string[] },
  requestId?: string,
): Promise<PayrollExportDTO> {
  const tz = input.timezone ?? (await userTimezone(q, actor.userId));
  assertTimezone(tz);
  await dateRange(q, input.period_from, input.period_to, tz, 93); // validates the period
  if (input.user_ids?.length) {
    const ok = await many(q, 'SELECT 1 FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[])', [actor.organizationId, input.user_ids]);
    if (ok.length !== new Set(input.user_ids).size) throw errors.notFound('User');
  }
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO payroll_exports (organization_id, requester_id, period_from, period_to, timezone, user_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [actor.organizationId, actor.userId, input.period_from, input.period_to, tz, input.user_ids?.length ? input.user_ids : null],
  );
  await enqueue(q, 'payroll.generate', { payroll_export_id: r!.id }, { organizationId: actor.organizationId });
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'payroll_export.create',
    targetType: 'payroll_export',
    targetId: r!.id,
    requestId,
    metadata: { period_from: input.period_from, period_to: input.period_to, users: input.user_ids?.length ?? null },
  });
  return getPayrollExport(deps, q, actor, r!.id);
}

export async function generatePayrollExport(deps: Deps, q: Queryable, id: string): Promise<void> {
  const job = await one<{ id: string; organization_id: string; period_from: string; period_to: string; timezone: string; user_ids: string[] | null }>(
    q,
    `UPDATE payroll_exports SET status = 'running' WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING id, organization_id, period_from::text AS period_from, period_to::text AS period_to, timezone, user_ids`,
    [id],
  );
  if (!job) return;
  const range = await dateRange(q, job.period_from, job.period_to, job.timezone);
  const rows = await timeWithPayRates(q, job.organization_id, range, { userIds: job.user_ids ?? undefined });
  const groups = [...groupSeconds(rows, (r) => `${r.user_id}|${r.rate_id ?? 'none'}`).values()].sort(
    (a, b) => a.first.user_name.localeCompare(b.first.user_name) || (a.first.rate_effective_from ?? '').localeCompare(b.first.rate_effective_from ?? ''),
  );
  const money = (c: number) => (c / 100).toFixed(2);
  const csv = toCsv(
    ['employee', 'email', 'period_from', 'period_to', 'hours', 'hourly_rate', 'currency', 'gross_pay', 'rate_effective_from'],
    groups.map((g) => {
      const hours = billableHours(g.seconds);
      const rate = g.first.rate_cents;
      return [
        g.first.user_name,
        g.first.email,
        job.period_from,
        job.period_to,
        hours.toFixed(2),
        rate === null ? null : money(rate),
        g.first.rate_currency,
        rate === null ? null : money(lineAmountCents(hours, rate)),
        g.first.rate_effective_from,
      ];
    }),
  );
  const key = `payroll/${job.organization_id}/${job.id}.csv`;
  await deps.store.put(key, csv, 'text/csv; charset=utf-8');
  await q.query(
    `UPDATE payroll_exports SET status = 'ready', object_key = $2, row_count = $3, included_user_ids = $4, completed_at = now(), expires_at = $5
     WHERE id = $1`,
    [job.id, key, groups.length, [...new Set(groups.map((g) => g.first.user_id))], new Date(deps.now().getTime() + EXPIRY_MS).toISOString()],
  );
}

export async function getPayrollExport(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<PayrollExportDTO> {
  const e = await one<PayrollExportDTO & { object_key: string | null; included_user_ids: string[] | null }>(
    q,
    `SELECT id, period_from::text AS period_from, period_to::text AS period_to, timezone, status, row_count, created_at, expires_at,
            object_key, included_user_ids, cardinality(COALESCE(included_user_ids, user_ids)) AS user_count
     FROM payroll_exports WHERE id = $1 AND organization_id = $2 AND requester_id = $3`,
    [id, actor.organizationId, actor.userId],
  );
  if (!e) throw errors.notFound('Payroll export');
  const expired = e.expires_at !== null && new Date(e.expires_at) <= deps.now();
  let download_url: string | null = null;
  // A download link is only handed out on a single, audited read (never in the list).
  if (e.status === 'ready' && !expired && e.object_key && requestId) {
    download_url = await deps.store.presignGet(e.object_key, 300, `rd-track-payroll-${e.period_from}-${e.period_to}.csv`);
    await audit(q, { organizationId: actor.organizationId, actor, action: 'payroll_export.download_url', targetType: 'payroll_export', targetId: id, requestId });
    for (const uid of e.included_user_ids ?? []) {
      if (uid === actor.userId) continue;
      await audit(q, {
        organizationId: actor.organizationId,
        actor,
        action: 'pay_rate.view',
        targetType: 'user',
        targetId: uid,
        targetUserId: uid,
        requestId,
        metadata: { via: 'payroll_export', payroll_export_id: id },
      });
    }
  }
  const { object_key: _k, included_user_ids: _u, ...dto } = e;
  return { ...dto, status: expired ? 'expired' : dto.status, download_url };
}

export async function listPayrollExports(deps: Deps, q: Queryable, actor: UserActor): Promise<PayrollExportDTO[]> {
  const ids = await many<{ id: string }>(
    q,
    'SELECT id FROM payroll_exports WHERE organization_id = $1 AND requester_id = $2 ORDER BY created_at DESC LIMIT 50',
    [actor.organizationId, actor.userId],
  );
  return Promise.all(ids.map((r) => getPayrollExport(deps, q, actor, r.id)));
}
