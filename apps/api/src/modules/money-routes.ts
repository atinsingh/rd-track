import {
  billRateCreateRequest,
  clientCreateRequest,
  clientUpdateRequest,
  invoiceDraftRequest,
  invoiceIssueRequest,
  invoiceLinesRequest,
  invoicePaidRequest,
  invoiceSendRequest,
  invoiceUpdateRequest,
  invoiceVoidRequest,
  payRateCreateRequest,
  payrollExportRequest,
  projectBudgetRequest,
  projectClientRequest,
} from '@rd/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps, UserActor } from '../context';
import { withTx } from '../db/pool';
import { MONEY_ROLES, requireRole, userOf } from '../http';
import { errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { deleteProjectBudget, getProjectBudget, listBudgets, putProjectBudget } from './money/budgets';
import * as cr from './money/clients-rates';
import * as inv from './money/invoices';
import { createPayrollExport, getPayrollExport, listPayrollExports } from './money/payroll';
import { assertMoneyPlan } from './money/time';

/**
 * Stage 3 money: clients, pay and bill rates, project budgets, invoices and payroll export.
 * Org admins and the finance role manage everything; project managers read budgets of their projects; employees
 * read their own pay rate only. Every route is gated on the `budgets_invoicing` entitlement
 * (402 plan_upgrade_required otherwise), checked after the role check.
 */
export async function moneyRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const optionalUuid = z.object({ user_id: z.uuid().optional(), project_id: z.uuid().optional() });

  /** Path ids are UUIDs; anything else cannot exist. */
  const id = (req: FastifyRequest<{ Params: { id: string } }>): string => {
    const r = z.uuid().safeParse(req.params.id);
    if (!r.success) throw errors.notFound();
    return r.data;
  };

  /** Org admin or finance, with the Pro entitlement. */
  const admin = async (req: FastifyRequest): Promise<UserActor> => {
    const a = requireRole(req, MONEY_ROLES);
    await assertMoneyPlan(deps, pool, a.organizationId);
    return a;
  };

  // ───────── clients ─────────
  app.get('/v1/admin/clients', user, async (req) => ({ items: await cr.listClients(pool, (await admin(req)).organizationId) }));
  app.post('/v1/admin/clients', user, async (req, reply) => {
    const a = await admin(req);
    const body = parse(clientCreateRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => cr.createClient(tx, a, body, req.id)));
  });
  app.patch<{ Params: { id: string } }>('/v1/admin/clients/:id', user, async (req) => {
    const a = await admin(req);
    const body = parse(clientUpdateRequest, req.body);
    return withTx(pool, (tx) => cr.updateClient(tx, a, id(req), body, req.id));
  });
  app.put<{ Params: { id: string } }>('/v1/admin/projects/:id/client', user, async (req) => {
    const a = await admin(req);
    const { client_id } = parse(projectClientRequest, req.body);
    return withTx(pool, (tx) => cr.setProjectClient(tx, a, id(req), client_id, req.id));
  });

  // ───────── rates ─────────
  app.get('/v1/admin/rates/pay', user, async (req) => {
    const a = await admin(req);
    const qs = parse(optionalUuid, req.query);
    return { items: await withTx(pool, (tx) => cr.listPayRates(tx, a, qs.user_id, req.id)) };
  });
  app.post('/v1/admin/rates/pay', user, async (req, reply) => {
    const a = await admin(req);
    const body = parse(payRateCreateRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => cr.createPayRate(tx, a, body, req.id)));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/rates/pay/:id', user, async (req) => {
    const a = await admin(req);
    return withTx(pool, (tx) => cr.deletePayRate(deps, tx, a, id(req), req.id));
  });
  app.get('/v1/admin/rates/bill', user, async (req) => {
    const a = await admin(req);
    const qs = parse(optionalUuid, req.query);
    return { items: await cr.listBillRates(pool, a.organizationId, qs.project_id) };
  });
  app.post('/v1/admin/rates/bill', user, async (req, reply) => {
    const a = await admin(req);
    const body = parse(billRateCreateRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => cr.createBillRate(tx, a, body, req.id)));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/rates/bill/:id', user, async (req) => {
    const a = await admin(req);
    return withTx(pool, (tx) => cr.deleteBillRate(deps, tx, a, id(req), req.id));
  });
  app.get('/v1/me/pay-rate', user, async (req) => {
    const a = userOf(req);
    await assertMoneyPlan(deps, pool, a.organizationId);
    return cr.myPayRate(deps, pool, a);
  });

  // ───────── budgets ─────────
  app.get('/v1/admin/budgets', user, async (req) => ({ items: await listBudgets(deps, pool, (await admin(req)).organizationId) }));
  app.get<{ Params: { id: string } }>('/v1/projects/:id/budget', user, async (req) =>
    getProjectBudget(deps, pool, userOf(req), id(req)),
  );
  app.put<{ Params: { id: string } }>('/v1/projects/:id/budget', user, async (req) => {
    const a = await admin(req);
    const body = parse(projectBudgetRequest, req.body);
    return withTx(pool, (tx) => putProjectBudget(deps, tx, a, id(req), body, req.id));
  });
  app.delete<{ Params: { id: string } }>('/v1/projects/:id/budget', user, async (req) => {
    const a = await admin(req);
    return withTx(pool, (tx) => deleteProjectBudget(tx, a, id(req), req.id));
  });

  // ───────── invoices ─────────
  app.get('/v1/admin/invoices', user, async (req) => ({ items: await inv.listInvoices(pool, (await admin(req)).organizationId) }));
  app.post('/v1/admin/invoices', user, async (req, reply) => {
    const a = await admin(req);
    const body = parse(invoiceDraftRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => inv.createDraftInvoice(deps, tx, a, body, req.id)));
  });
  app.get<{ Params: { id: string } }>('/v1/admin/invoices/:id', user, async (req) =>
    inv.getInvoice(pool, (await admin(req)).organizationId, id(req)),
  );
  app.patch<{ Params: { id: string } }>('/v1/admin/invoices/:id', user, async (req) => {
    const a = await admin(req);
    const body = parse(invoiceUpdateRequest, req.body);
    return withTx(pool, (tx) => inv.updateDraftInvoice(tx, a, id(req), body, req.id));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/invoices/:id', user, async (req) => {
    const a = await admin(req);
    return withTx(pool, (tx) => inv.deleteDraftInvoice(tx, a, id(req), req.id));
  });
  app.put<{ Params: { id: string } }>('/v1/admin/invoices/:id/lines', user, async (req) => {
    const a = await admin(req);
    const { lines } = parse(invoiceLinesRequest, req.body);
    return withTx(pool, (tx) => inv.replaceDraftLines(tx, a, id(req), lines, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/invoices/:id/issue', user, async (req) => {
    const a = await admin(req);
    const { due_date } = parse(invoiceIssueRequest, req.body ?? {});
    return withTx(pool, (tx) => inv.issueInvoice(deps, tx, a, id(req), due_date, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/invoices/:id/void', user, async (req) => {
    const a = await admin(req);
    const { reason } = parse(invoiceVoidRequest, req.body ?? {});
    return withTx(pool, (tx) => inv.voidInvoice(deps, tx, a, id(req), reason, req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/invoices/:id/paid', user, async (req) => {
    const a = await admin(req);
    const { paid_on, note } = parse(invoicePaidRequest, req.body);
    return withTx(pool, (tx) => inv.markInvoicePaid(tx, a, id(req), paid_on, note, req.id));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/invoices/:id/paid', user, async (req) => {
    const a = await admin(req);
    return withTx(pool, (tx) => inv.markInvoiceUnpaid(tx, a, id(req), req.id));
  });
  app.post<{ Params: { id: string } }>('/v1/admin/invoices/:id/send', user, async (req) => {
    const a = await admin(req);
    const body = parse(invoiceSendRequest, req.body ?? {});
    const { invoice, message } = await withTx(pool, (tx) => inv.prepareInvoiceEmail(deps, tx, a, id(req), body, req.id));
    // After commit, like invites: a failed send leaves sent_at recorded, and sending again is safe.
    await deps.email.send(message);
    return invoice;
  });
  app.get<{ Params: { id: string } }>('/v1/admin/invoices/:id/csv', user, async (req, reply) => {
    const a = await admin(req);
    const { filename, csv } = await withTx(pool, (tx) => inv.invoiceCsv(tx, a, id(req), req.id));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .send(csv);
  });

  // ───────── payroll ─────────
  app.get('/v1/admin/payroll-exports', user, async (req) => ({ items: await listPayrollExports(deps, pool, await admin(req)) }));
  app.post('/v1/admin/payroll-exports', user, async (req, reply) => {
    const a = await admin(req);
    const body = parse(payrollExportRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => createPayrollExport(deps, tx, a, body, req.id)));
  });
  app.get<{ Params: { id: string } }>('/v1/admin/payroll-exports/:id', user, async (req) => {
    const a = await admin(req);
    return withTx(pool, (tx) => getPayrollExport(deps, tx, a, id(req), req.id));
  });
}
