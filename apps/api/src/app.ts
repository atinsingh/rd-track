import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './context';
import { SYSTEM_SCOPE, tenantScope } from './db/tenant-scope';
import { CLIENT_COOKIE, PLATFORM_COOKIE, SESSION_COOKIE } from './http';
import { AppError } from './lib/errors';
import { adminRoutes } from './modules/admin-routes';
import { agentRoutes } from './modules/agent-routes';
import { commerceRoutes } from './modules/commerce-routes';
import { insightsRoutes } from './modules/insights-routes';
import { approvalsRoutes } from './modules/approvals-routes';
import { workspacesRoutes } from './modules/workspaces-routes';
import { lifecycleRoutes } from './modules/lifecycle-routes';
import { authenticateDirectory } from './modules/scim/service';
import { authenticateToken } from './modules/api-tokens/service';
import { apiEndpoint } from './modules/api-tokens/surface';
import { developerRoutes } from './modules/developer-routes';
import { authenticateClient } from './modules/client-portal/service';
import { clientPortalRoutes } from './modules/client-portal-routes';
import { expensesRoutes } from './modules/expenses-routes';
import { audit } from './modules/audit/service';
import { withScope } from './db/tenant-scope';
import { scimRoutes } from './modules/scim-routes';
import { ssoRoutes } from './modules/sso-routes';
import { moneyRoutes } from './modules/money-routes';
import { authRoutes } from './modules/auth/routes';
import { authenticateDevice, authenticateUser } from './modules/auth/service';
import { peopleRoutes } from './modules/people-routes';
import { schedulingRoutes } from './modules/scheduling/routes';
import { authenticatePlatform, platformRoutes } from './modules/platform/routes';
import { timesheetRoutes } from './modules/timesheets-routes';
import { localStorageRoutes } from './storage/local-routes';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1);

/** From here on, row-level security limits this request to one organization. */
function narrowScope(organizationId: string) {
  const store = tenantScope.getStore();
  if (!store) throw new AppError(500, 'internal_error', 'Request has no tenant scope');
  store.org = organizationId;
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: process.env.LOG_LEVEL ?? 'info',
          // Never log credentials, cookies or bodies (security §9, SCR-11).
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        }
      : false,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : randomUUID();
    },
    bodyLimit: 256 * 1024,
    // Only the load balancer in front of us is trusted, so X-Forwarded-For can't be spoofed
    // to dodge per-IP rate limits (TRUST_PROXY_HOPS=0 when exposed directly).
    trustProxy: (_address: string, hop: number) => hop < TRUST_PROXY_HOPS,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Every request runs in its own tenant scope (system until authentication narrows it).
  app.addHook('onRequest', (_req, _reply, done) => {
    tenantScope.run({ org: SYSTEM_SCOPE }, done);
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });

  // Authentication per route (`config.auth`); every route must declare one.
  app.addHook('onRequest', async (req) => {
    const cfg = req.routeOptions.config;
    const mode = cfg.auth;
    if (!req.routeOptions.url) return; // 404s fall through to the not-found handler
    if (mode === undefined) throw new AppError(500, 'internal_error', 'Route has no auth mode');
    if (mode === 'public') return;

    if (mode === 'device') {
      const h = req.headers.authorization ?? '';
      const m = /^Device\s+([A-Za-z0-9_-]{20,200})$/.exec(h);
      if (!m) throw new AppError(401, 'unauthenticated', 'Device credential required');
      const d = await authenticateDevice(deps.pool, m[1]!);
      if (d === 'revoked') throw new AppError(401, 'device_revoked', 'This device has been revoked');
      if (!d) throw new AppError(401, 'unauthenticated', 'Unknown device credential');
      req.device = d;
      narrowScope(d.organizationId);
      return;
    }

    if (mode === 'directory') {
      const m = /^Bearer\s+(\S{20,300})$/i.exec(req.headers.authorization ?? '');
      const d = m ? await authenticateDirectory(deps, deps.pool, m[1]!) : null;
      if (d === 'not_entitled') throw new AppError(403, 'forbidden', 'Directory sync is part of the Pro plan');
      if (!d) throw new AppError(401, 'unauthenticated', 'A valid directory token is required');
      req.directory = d;
      narrowScope(d.organizationId);
      return;
    }

    if (mode === 'platform') {
      const token = req.cookies[PLATFORM_COOKIE];
      const p = token ? await authenticatePlatform(deps, deps.pool, token) : null;
      if (!p) throw new AppError(401, 'unauthenticated', 'Sign in required');
      if (!SAFE_METHODS.has(req.method) && req.headers['x-rd-csrf'] !== '1') {
        throw new AppError(403, 'csrf_failed', 'Missing x-rd-csrf header');
      }
      req.platform = p;
      return;
    }

    if (mode === 'client') {
      const token = req.cookies[CLIENT_COOKIE];
      const c = token ? await authenticateClient(deps, deps.pool, token) : null;
      if (c === 'not_entitled') throw new AppError(403, 'portal_unavailable', 'The client portal is not available for this organization');
      if (!c) throw new AppError(401, 'unauthenticated', 'Sign in required');
      if (!SAFE_METHODS.has(req.method) && req.headers['x-rd-csrf'] !== '1') {
        throw new AppError(403, 'csrf_failed', 'Missing x-rd-csrf header');
      }
      req.client = c;
      narrowScope(c.organizationId);
      return;
    }

    // API tokens (F5): `Authorization: Bearer rdt_…`, only on the routes in the API reference.
    const bearer = /^Bearer\s+(rdt_(?:org|pat)_[A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '');
    if (bearer) {
      const t = await authenticateToken(deps, deps.pool, bearer[1]!);
      if (t === 'not_entitled') throw new AppError(403, 'plan_upgrade_required', 'The API is part of the Pro plan');
      if (!t) throw new AppError(401, 'invalid_token', 'This API token is unknown, revoked or expired');
      req.apiCaller = t;
      const endpoint = apiEndpoint(req.method, req.routeOptions.url);
      if (!endpoint) throw new AppError(403, 'not_in_api', 'API tokens can only call the endpoints in the API reference (/v1/docs)');
      if (t.token!.kind === 'personal' && !endpoint.personal) throw new AppError(403, 'insufficient_scope', 'Personal tokens read only your own data');
      const missing = endpoint.scopes.filter((sc) => !t.token!.scopes.includes(sc));
      if (missing.length) throw new AppError(403, 'insufficient_scope', `This token needs the ${missing.join(' and ')} scope`);
      req.user = t;
      narrowScope(t.organizationId);
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    const u = token ? await authenticateUser(deps, deps.pool, token) : null;
    if (!u) throw new AppError(401, 'unauthenticated', 'Sign in required');
    // A custom header can't be sent by a cross-site form; SameSite=Strict covers the rest.
    if (!SAFE_METHODS.has(req.method) && req.headers['x-rd-csrf'] !== '1') {
      throw new AppError(403, 'csrf_failed', 'Missing x-rd-csrf header');
    }
    if (!u.mfaVerified && !cfg.allowWithoutMfa) throw new AppError(403, 'mfa_required', 'Multi-factor authentication is required');
    req.user = u;
    narrowScope(u.organizationId);
  });

  // Every call made with an API token is in the audit log under the token, allowed or not.
  app.addHook('onResponse', async (req, reply) => {
    const caller = req.apiCaller;
    if (!caller) return;
    const status = reply.statusCode;
    await withScope(caller.organizationId, () =>
      audit(deps.pool, {
        organizationId: caller.organizationId,
        actor: caller,
        action: 'api.request',
        targetType: 'api_token',
        targetId: caller.token!.id,
        result: status < 400 ? 'success' : status === 401 || status === 403 ? 'denied' : 'error',
        requestId: req.id,
        metadata: { method: req.method, route: req.routeOptions.url ?? null, status },
      }),
    ).catch((e) => req.log.error({ err: { message: (e as Error).message } }, 'api audit failed'));
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, request_id: req.id, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'payload_too_large', message: 'Request body too large', request_id: req.id } });
    }
    if (e.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests', request_id: req.id } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: 'Malformed request', request_id: req.id } });
    }
    req.log.error({ err: { message: e.message, code: e.code } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong', request_id: req.id } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found', request_id: req.id } }),
  );

  app.get('/healthz', { config: { auth: 'public' } }, async () => {
    await deps.pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(async (s) => authRoutes(s, deps));
  await app.register(async (s) => agentRoutes(s, deps));
  await app.register(async (s) => peopleRoutes(s, deps));
  await app.register(async (s) => adminRoutes(s, deps));
  await app.register(async (s) => commerceRoutes(s, deps));
  await app.register(async (s) => insightsRoutes(s, deps));
  await app.register(async (s) => approvalsRoutes(s, deps));
  await app.register(async (s) => workspacesRoutes(s, deps));
  await app.register(async (s) => lifecycleRoutes(s, deps));
  await app.register(async (s) => ssoRoutes(s, deps));
  await app.register(async (s) => scimRoutes(s, deps));
  await app.register(async (s) => developerRoutes(s, deps));
  await app.register(async (s) => expensesRoutes(s, deps));
  await app.register(async (s) => timesheetRoutes(s, deps));
  await app.register(async (s) => schedulingRoutes(s, deps));
  await app.register(async (s) => moneyRoutes(s, deps));
  await app.register(async (s) => platformRoutes(s, deps));
  await app.register(async (s) => clientPortalRoutes(s, deps));
  await app.register(async (s) => localStorageRoutes(s, deps));
  return app;
}
