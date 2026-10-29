import { clientContactCreate, clientLinkAcceptRequest, clientLoginRequest, clientPortalSettingsRequest } from '@rd/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps, UserActor } from '../context';
import { withTx } from '../db/pool';
import { CLIENT_COOKIE, MONEY_ROLES, clearSessionCookie, clientOf, requireRole, setSessionCookie } from '../http';
import { errors } from '../lib/errors';
import { parse, parseRange } from '../lib/validate';
import * as portal from './client-portal/service';
import { assertMoneyPlan } from './money/time';

/** The client portal (Stage 4 F9): the agency manages contacts; contacts read their own projects. */
export async function clientPortalRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const client = { config: { auth: 'client' as const } };
  const limited = { config: { auth: 'public' as const, rateLimit: { max: 5, timeWindow: '1 minute' } } };
  const money = async (req: FastifyRequest): Promise<UserActor> => {
    const a = requireRole(req, MONEY_ROLES);
    await assertMoneyPlan(deps, pool, a.organizationId);
    return a;
  };
  const id = (req: FastifyRequest<{ Params: { id: string } }>) => parse(z.uuid(), req.params.id);
  const tz = (v: unknown): string => {
    const s = typeof v === 'string' && v ? v : 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: s });
      return s;
    } catch {
      throw errors.validation('Unknown time zone');
    }
  };

  // ───────── the agency: contacts and what they see ─────────
  app.get<{ Params: { id: string } }>('/v1/admin/clients/:id/contacts', user, async (req) => ({
    items: await portal.listContacts(pool, (await money(req)).organizationId, id(req)),
  }));
  app.post<{ Params: { id: string } }>('/v1/admin/clients/:id/contacts', user, async (req, reply) => {
    const a = await money(req);
    const body = parse(clientContactCreate, req.body);
    const { contact, email } = await withTx(pool, (tx) => portal.inviteContact(deps, tx, a, id(req), body, req.id));
    await deps.email.send(email);
    return reply.code(201).send(contact);
  });
  app.post<{ Params: { id: string } }>('/v1/admin/client-contacts/:id/send-link', user, async (req) => {
    const a = await money(req);
    const email = await withTx(pool, (tx) => portal.resendLink(deps, tx, a, id(req), req.id));
    await deps.email.send(email);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/v1/admin/client-contacts/:id/revoke', user, async (req) => {
    const a = await money(req);
    return withTx(pool, (tx) => portal.revokeContact(deps, tx, a, id(req), req.id));
  });
  app.put<{ Params: { id: string } }>('/v1/admin/clients/:id/portal', user, async (req) => {
    const a = await money(req);
    const body = parse(clientPortalSettingsRequest, req.body);
    return withTx(pool, (tx) => portal.setPortalSettings(tx, a, id(req), body.show_people, req.id));
  });

  // ───────── signing in ─────────
  app.post('/v1/client-portal/auth/login', limited, async (req, reply) => {
    const body = parse(clientLoginRequest, req.body);
    const token = await withTx(pool, (tx) => portal.login(deps, tx, body.email, body.password, req.id));
    setSessionCookie(reply, CLIENT_COOKIE, token, deps.config.cookieSecure, portal.CLIENT_SESSION_HOURS * 3600);
    return { ok: true };
  });
  app.get<{ Querystring: { token?: string } }>('/v1/client-portal/auth/link', limited, async (req) =>
    portal.linkInfo(deps, pool, parse(z.string().min(20).max(200), req.query.token)),
  );
  app.post('/v1/client-portal/auth/link', limited, async (req, reply) => {
    const body = parse(clientLinkAcceptRequest, req.body);
    const token = await withTx(pool, (tx) => portal.acceptLink(deps, tx, body.token, body.password, req.id));
    setSessionCookie(reply, CLIENT_COOKIE, token, deps.config.cookieSecure, portal.CLIENT_SESSION_HOURS * 3600);
    return { ok: true };
  });
  app.post('/v1/client-portal/auth/logout', client, async (req, reply) => {
    await portal.logout(pool, req.cookies[CLIENT_COOKIE]!, deps.now());
    clearSessionCookie(reply, CLIENT_COOKIE);
    return { ok: true };
  });

  // ───────── what the client sees ─────────
  app.get('/v1/client-portal/me', client, async (req) => portal.portalMe(pool, clientOf(req)));
  app.get<{ Querystring: { from?: string; to?: string; tz?: string } }>('/v1/client-portal/report', client, async (req) =>
    withTx(pool, (tx) => portal.portalReport(deps, tx, clientOf(req), parseRange(req.query, 366), tz(req.query.tz), req.id)),
  );
  app.get('/v1/client-portal/invoices', client, async (req) => ({ items: await portal.portalInvoices(pool, clientOf(req)) }));
  app.get<{ Params: { id: string } }>('/v1/client-portal/invoices/:id', client, async (req) => portal.portalInvoice(pool, clientOf(req), id(req)));
}
