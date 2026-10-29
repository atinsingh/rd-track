import type { BillRateDTO, ClientDTO, MyPayRateResponse, PayRateDTO } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { assertInOrg } from '../org/service';

/**
 * Clients and effective-dated rates. Rates are append-only history: a change is a new row
 * with a later `effective_from`; only a rate that has not started yet may be deleted.
 * Pay rates are personal and sensitive: reads by anyone but the employee are audited as
 * `pay_rate.view`, changes as `pay_rate.create` / `pay_rate.delete`, and audit metadata
 * never carries the amount.
 */

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

// ───────────────────────── clients ─────────────────────────

const CLIENT_SELECT = `
  SELECT c.id, c.name, c.contact_email, c.currency, c.address, c.archived, c.created_at, c.portal_show_people,
         COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                   FROM projects p WHERE p.client_id = c.id), '[]'::json) AS projects
  FROM clients c`;

export async function listClients(q: Queryable, orgId: string): Promise<ClientDTO[]> {
  return many<ClientDTO>(q, `${CLIENT_SELECT} WHERE c.organization_id = $1 ORDER BY c.archived, c.name`, [orgId]);
}

async function getClient(q: Queryable, orgId: string, id: string): Promise<ClientDTO> {
  const c = await one<ClientDTO>(q, `${CLIENT_SELECT} WHERE c.organization_id = $1 AND c.id = $2`, [orgId, id]);
  if (!c) throw errors.notFound('Client');
  return c;
}

export async function createClient(
  q: Queryable,
  actor: UserActor,
  input: { name: string; contact_email?: string | null; currency: string; address?: string | null },
  requestId?: string,
): Promise<ClientDTO> {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO clients (organization_id, name, contact_email, currency, address) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, name) DO NOTHING RETURNING id`,
    [actor.organizationId, input.name, input.contact_email ?? null, input.currency, input.address ?? null],
  );
  if (!r) throw errors.conflict('name_taken', 'A client with this name already exists');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'client.create', targetType: 'client', targetId: r.id, requestId });
  return getClient(q, actor.organizationId, r.id);
}

export async function updateClient(
  q: Queryable,
  actor: UserActor,
  id: string,
  input: { name?: string; contact_email?: string | null; currency?: string; address?: string | null; archived?: boolean },
  requestId?: string,
): Promise<ClientDTO> {
  await getClient(q, actor.organizationId, id);
  try {
    await q.query(
      `UPDATE clients SET
         name = COALESCE($3, name),
         contact_email = CASE WHEN $4::boolean THEN $5 ELSE contact_email END,
         currency = COALESCE($6, currency),
         address = CASE WHEN $7::boolean THEN $8 ELSE address END,
         archived = COALESCE($9, archived)
       WHERE id = $1 AND organization_id = $2`,
      [
        id,
        actor.organizationId,
        input.name ?? null,
        input.contact_email !== undefined,
        input.contact_email ?? null,
        input.currency ?? null,
        input.address !== undefined,
        input.address ?? null,
        input.archived ?? null,
      ],
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.conflict('name_taken', 'A client with this name already exists');
    throw e;
  }
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'client.update',
    targetType: 'client',
    targetId: id,
    requestId,
    metadata: { fields: Object.keys(input) },
  });
  return getClient(q, actor.organizationId, id);
}

export async function setProjectClient(q: Queryable, actor: UserActor, projectId: string, clientId: string | null, requestId?: string) {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  if (clientId) await getClient(q, actor.organizationId, clientId);
  await q.query('UPDATE projects SET client_id = $3 WHERE id = $1 AND organization_id = $2', [projectId, actor.organizationId, clientId]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'project.client_set',
    targetType: 'project',
    targetId: projectId,
    requestId,
    metadata: { client_id: clientId },
  });
  return { project_id: projectId, client_id: clientId };
}

// ───────────────────────── pay rates ─────────────────────────

const PAY_SELECT = `
  SELECT r.id, r.user_id, u.display_name AS user_name, r.amount_cents, r.currency, r.effective_from::text AS effective_from, r.created_at
  FROM pay_rates r JOIN users u ON u.id = r.user_id`;

/** Admin view of pay rate history. Every person whose rate is shown gets a `pay_rate.view` entry in their access log. */
export async function listPayRates(q: Queryable, actor: UserActor, userId: string | undefined, requestId?: string): Promise<PayRateDTO[]> {
  if (userId) await assertInOrg(q, actor.organizationId, 'users', userId, 'User');
  const rows = await many<PayRateDTO>(
    q,
    `${PAY_SELECT} WHERE r.organization_id = $1 AND ($2::uuid IS NULL OR r.user_id = $2)
     ORDER BY u.display_name, r.effective_from DESC`,
    [actor.organizationId, userId ?? null],
  );
  const viewed = new Set(rows.map((r) => r.user_id));
  viewed.delete(actor.userId);
  for (const target of viewed) {
    await audit(q, {
      organizationId: actor.organizationId,
      actor,
      action: 'pay_rate.view',
      targetType: 'user',
      targetId: target,
      targetUserId: target,
      requestId,
    });
  }
  return rows;
}

export async function createPayRate(
  q: Queryable,
  actor: UserActor,
  input: { user_id: string; amount_cents: number; currency: string; effective_from: string },
  requestId?: string,
): Promise<PayRateDTO> {
  await assertInOrg(q, actor.organizationId, 'users', input.user_id, 'User');
  let id: string;
  try {
    id = (await one<{ id: string }>(
      q,
      `INSERT INTO pay_rates (organization_id, user_id, amount_cents, currency, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [actor.organizationId, input.user_id, input.amount_cents, input.currency, input.effective_from, actor.userId],
    ))!.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.conflict('rate_exists', 'A pay rate already starts on this date. Choose another start date.');
    throw e;
  }
  // The amount stays out of the audit trail: auditors see that pay changed, not what it is.
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'pay_rate.create',
    targetType: 'pay_rate',
    targetId: id,
    targetUserId: input.user_id,
    requestId,
    metadata: { effective_from: input.effective_from, currency: input.currency },
  });
  return (await one<PayRateDTO>(q, `${PAY_SELECT} WHERE r.id = $1`, [id]))!;
}

export async function deletePayRate(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await one<{ user_id: string; effective_from: string }>(
    q,
    `SELECT user_id, effective_from::text AS effective_from FROM pay_rates WHERE id = $1 AND organization_id = $2`,
    [id, actor.organizationId],
  );
  if (!r) throw errors.notFound('Pay rate');
  if (r.effective_from <= todayUtc(deps.now())) {
    throw errors.conflict('rate_in_effect', 'This rate has already started and is part of the pay history. Add a new rate instead.');
  }
  await q.query('DELETE FROM pay_rates WHERE id = $1', [id]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'pay_rate.delete',
    targetType: 'pay_rate',
    targetId: id,
    targetUserId: r.user_id,
    requestId,
    metadata: { effective_from: r.effective_from },
  });
  return { ok: true };
}

/** The employee's own pay rate (never anyone else's): the one in effect today, and the next one if scheduled. */
export async function myPayRate(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor): Promise<MyPayRateResponse> {
  const rows = await many<{ amount_cents: number; currency: string; effective_from: string; future: boolean }>(
    q,
    `SELECT r.amount_cents, r.currency, r.effective_from::text AS effective_from,
            r.effective_from > ($3::timestamptz AT TIME ZONE u.timezone)::date AS future
     FROM pay_rates r JOIN users u ON u.id = r.user_id
     WHERE r.organization_id = $1 AND r.user_id = $2 ORDER BY r.effective_from DESC`,
    [actor.organizationId, actor.userId, deps.now().toISOString()],
  );
  const strip = (r: (typeof rows)[number] | undefined) =>
    r ? { amount_cents: r.amount_cents, currency: r.currency, effective_from: r.effective_from } : null;
  const future = rows.filter((r) => r.future);
  return { current: strip(rows.find((r) => !r.future)), upcoming: strip(future[future.length - 1]) };
}

// ───────────────────────── bill rates ─────────────────────────

const BILL_SELECT = `
  SELECT r.id, r.project_id, p.name AS project_name, r.user_id, u.display_name AS user_name,
         r.amount_cents, r.currency, r.effective_from::text AS effective_from, r.created_at
  FROM bill_rates r JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = r.user_id`;

export async function listBillRates(q: Queryable, orgId: string, projectId?: string): Promise<BillRateDTO[]> {
  return many<BillRateDTO>(
    q,
    `${BILL_SELECT} WHERE r.organization_id = $1 AND ($2::uuid IS NULL OR r.project_id = $2)
     ORDER BY p.name, u.display_name NULLS FIRST, r.effective_from DESC`,
    [orgId, projectId ?? null],
  );
}

export async function createBillRate(
  q: Queryable,
  actor: UserActor,
  input: { project_id: string; user_id?: string | null; amount_cents: number; currency: string; effective_from: string },
  requestId?: string,
): Promise<BillRateDTO> {
  await assertInOrg(q, actor.organizationId, 'projects', input.project_id, 'Project');
  if (input.user_id) await assertInOrg(q, actor.organizationId, 'users', input.user_id, 'User');
  let id: string;
  try {
    id = (await one<{ id: string }>(
      q,
      `INSERT INTO bill_rates (organization_id, project_id, user_id, amount_cents, currency, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [actor.organizationId, input.project_id, input.user_id ?? null, input.amount_cents, input.currency, input.effective_from, actor.userId],
    ))!.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.conflict('rate_exists', 'A bill rate already starts on this date. Choose another start date.');
    throw e;
  }
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'bill_rate.create',
    targetType: 'bill_rate',
    targetId: id,
    targetUserId: input.user_id ?? undefined,
    requestId,
    metadata: { project_id: input.project_id, effective_from: input.effective_from, amount_cents: input.amount_cents, currency: input.currency },
  });
  return (await one<BillRateDTO>(q, `${BILL_SELECT} WHERE r.id = $1`, [id]))!;
}

export async function deleteBillRate(deps: Pick<Deps, 'now'>, q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await one<{ project_id: string; effective_from: string }>(
    q,
    `SELECT project_id, effective_from::text AS effective_from FROM bill_rates WHERE id = $1 AND organization_id = $2`,
    [id, actor.organizationId],
  );
  if (!r) throw errors.notFound('Bill rate');
  if (r.effective_from <= todayUtc(deps.now())) {
    throw errors.conflict('rate_in_effect', 'This rate has already started and is part of the billing history. Add a new rate instead.');
  }
  await q.query('DELETE FROM bill_rates WHERE id = $1', [id]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'bill_rate.delete',
    targetType: 'bill_rate',
    targetId: id,
    requestId,
    metadata: { project_id: r.project_id, effective_from: r.effective_from },
  });
  return { ok: true };
}
