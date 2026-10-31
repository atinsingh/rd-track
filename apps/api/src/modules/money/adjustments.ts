import type { PayrollAdjustmentDTO, PayrollAdjustmentKind } from '@rd/contracts';
import type { UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';

/**
 * Payroll adjustments (Stage 4 F8): bonuses, deductions and reimbursements beside hours ×
 * pay rate. One-time ones fall in the pay period containing their date; recurring ones in
 * every period they overlap. Like pay rates, amounts stay out of the audit log.
 */

const SELECT = `
  SELECT a.id, a.user_id, u.display_name AS user_name, a.kind, a.amount_cents::int AS amount_cents, a.currency, a.note, a.recurrence,
    a.effective_from::text AS effective_from, a.effective_to::text AS effective_to, c.display_name AS created_by_name, a.created_at
  FROM payroll_adjustments a JOIN users u ON u.id = a.user_id LEFT JOIN users c ON c.id = a.created_by`;

export async function listAdjustments(q: Queryable, orgId: string, userId?: string): Promise<PayrollAdjustmentDTO[]> {
  return many<PayrollAdjustmentDTO>(
    q,
    `${SELECT} WHERE a.organization_id = $1 AND ($2::uuid IS NULL OR a.user_id = $2) ORDER BY a.effective_from DESC, u.display_name LIMIT 500`,
    [orgId, userId ?? null],
  );
}

/** Admin view: like pay rates, everyone whose adjustments are shown gets a `payroll_adjustment.view` entry in their access log. */
export async function listAdjustmentsAsAdmin(q: Queryable, actor: UserActor, userId?: string, requestId?: string): Promise<PayrollAdjustmentDTO[]> {
  const rows = await listAdjustments(q, actor.organizationId, userId);
  const viewed = new Set(rows.map((r) => r.user_id));
  viewed.delete(actor.userId);
  for (const target of viewed)
    await audit(q, { organizationId: actor.organizationId, actor, action: 'payroll_adjustment.view', targetType: 'user', targetId: target, targetUserId: target, requestId });
  return rows;
}

export async function createAdjustment(
  q: Queryable,
  actor: UserActor,
  input: { user_id: string; kind: PayrollAdjustmentKind; amount_cents: number; currency: string; note: string; recurrence: 'once' | 'every_period'; effective_from: string; effective_to?: string | null },
  requestId?: string,
): Promise<PayrollAdjustmentDTO> {
  const u = await one(q, 'SELECT 1 FROM users WHERE organization_id = $1 AND id = $2', [actor.organizationId, input.user_id]);
  if (!u) throw errors.notFound('User');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO payroll_adjustments (organization_id, user_id, kind, amount_cents, currency, note, recurrence, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [actor.organizationId, input.user_id, input.kind, input.amount_cents, input.currency, input.note, input.recurrence, input.effective_from, input.effective_to ?? null, actor.userId],
  );
  // No amount here, as for pay rates.
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'payroll_adjustment.create',
    targetType: 'payroll_adjustment',
    targetId: r!.id,
    targetUserId: input.user_id,
    requestId,
    metadata: { kind: input.kind, recurrence: input.recurrence, effective_from: input.effective_from },
  });
  return (await one<PayrollAdjustmentDTO>(q, `${SELECT} WHERE a.id = $1`, [r!.id]))!;
}

/** Ends a recurring adjustment on a date (it still applies that day). */
export async function endAdjustment(q: Queryable, actor: UserActor, id: string, effectiveTo: string, requestId?: string): Promise<PayrollAdjustmentDTO> {
  const a = await one<{ user_id: string; recurrence: string; effective_from: string }>(
    q,
    'SELECT user_id, recurrence, effective_from::text AS effective_from FROM payroll_adjustments WHERE organization_id = $1 AND id = $2',
    [actor.organizationId, id],
  );
  if (!a) throw errors.notFound('Adjustment');
  if (a.recurrence !== 'every_period') throw errors.conflict('not_recurring', 'Only a recurring adjustment can be ended; delete a one-time one');
  if (effectiveTo < a.effective_from) throw errors.validation('The end date is before the start');
  await q.query('UPDATE payroll_adjustments SET effective_to = $2 WHERE id = $1', [id, effectiveTo]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'payroll_adjustment.end', targetType: 'payroll_adjustment', targetId: id, targetUserId: a.user_id, requestId, metadata: { effective_to: effectiveTo } });
  return (await one<PayrollAdjustmentDTO>(q, `${SELECT} WHERE a.id = $1`, [id]))!;
}

export async function deleteAdjustment(q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<void> {
  const a = await one<{ user_id: string }>(q, 'DELETE FROM payroll_adjustments WHERE organization_id = $1 AND id = $2 RETURNING user_id', [actor.organizationId, id]);
  if (!a) throw errors.notFound('Adjustment');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'payroll_adjustment.delete', targetType: 'payroll_adjustment', targetId: id, targetUserId: a.user_id, requestId });
}

/** What applies to a pay period, summed per person, currency and kind. */
export async function adjustmentsFor(
  q: Queryable,
  orgId: string,
  period: { from: string; to: string },
  userIds: string[] | null,
): Promise<{ user_id: string; currency: string; kind: PayrollAdjustmentKind; cents: number }[]> {
  return many(
    q,
    `SELECT user_id, currency, kind, sum(amount_cents)::bigint AS cents FROM payroll_adjustments
     WHERE organization_id = $1 AND ($4::uuid[] IS NULL OR user_id = ANY($4))
       AND CASE recurrence
             WHEN 'once' THEN effective_from BETWEEN $2 AND $3
             ELSE effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $2)
           END
     GROUP BY user_id, currency, kind`,
    [orgId, period.from, period.to, userIds],
  ).then((rows) => rows.map((r) => ({ ...(r as { user_id: string; currency: string; kind: PayrollAdjustmentKind }), cents: Number((r as { cents: number }).cents) })));
}
