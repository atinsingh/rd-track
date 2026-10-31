import { expenseCreateRequest, receiptUploadRequest, type ExpenseDTO, type MyExpensesResponse, type ReceiptUploadResponse } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { MONEY_ROLES, requireRole, userOf } from '../http';
import { parse } from '../lib/validate';
import * as exp from './expenses/service';

const sinceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const decision = z.strictObject({ note: z.string().trim().max(1000).optional() });

/** Stage 4 F7: expense claims, their review, and their receipts. */
export async function expensesRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const defaultSince = () => new Date(deps.now().getTime() - 92 * 86_400_000).toISOString().slice(0, 10);

  app.post('/v1/me/expenses/receipt-uploads', user, async (req, reply): Promise<ReceiptUploadResponse> => {
    const { content_type } = parse(receiptUploadRequest, req.body);
    return reply.code(201).send(await exp.receiptUpload(deps, pool, userOf(req), content_type));
  });
  app.get<{ Querystring: { from?: string } }>('/v1/me/expenses', user, async (req): Promise<MyExpensesResponse> =>
    exp.myExpenses(deps, pool, userOf(req), parse(sinceDate, req.query.from) ?? defaultSince()),
  );
  app.post('/v1/me/expenses', user, async (req, reply) => {
    const a = userOf(req);
    const body = parse(expenseCreateRequest, req.body);
    const e: ExpenseDTO = await withTx(pool, (tx) => exp.createExpense(deps, tx, a, body, req.id));
    return reply.code(201).send(e);
  });
  app.post<{ Params: { id: string } }>('/v1/me/expenses/:id/cancel', user, async (req): Promise<ExpenseDTO> => {
    const a = userOf(req);
    return withTx(pool, (tx) => exp.cancelExpense(tx, a, parse(z.uuid(), req.params.id), req.id));
  });

  app.get('/v1/expenses/pending', user, async (req): Promise<{ items: ExpenseDTO[] }> => ({ items: await exp.pendingExpenses(deps, pool, userOf(req)) }));
  for (const [verb, approve] of [['approve', true], ['reject', false]] as const) {
    app.post<{ Params: { id: string } }>(`/v1/expenses/:id/${verb}`, user, async (req): Promise<ExpenseDTO> => {
      const a = userOf(req);
      const { note } = parse(decision, req.body ?? {});
      return withTx(pool, (tx) => exp.reviewExpense(deps, tx, a, parse(z.uuid(), req.params.id), approve, note, req.id));
    });
  }
  app.get<{ Params: { id: string } }>('/v1/expenses/:id/receipt-url', user, async (req) => {
    const a = userOf(req);
    return withTx(pool, (tx) => exp.receiptUrl(deps, tx, a, parse(z.uuid(), req.params.id), req.id));
  });
  app.get<{ Querystring: { from?: string } }>('/v1/admin/expenses', user, async (req): Promise<{ items: ExpenseDTO[] }> => ({
    items: await exp.approvedExpenses(deps, pool, requireRole(req, MONEY_ROLES), parse(sinceDate, req.query.from) ?? defaultSince()),
  }));
}
