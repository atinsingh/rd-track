import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './context';
import { PLATFORM_COOKIE, SESSION_COOKIE } from './http';
import { AppError } from './lib/errors';
import { adminRoutes } from './modules/admin-routes';
import { agentRoutes } from './modules/agent-routes';
import { authRoutes } from './modules/auth/routes';
import { authenticateDevice, authenticateUser } from './modules/auth/service';
import { peopleRoutes } from './modules/people-routes';
import { authenticatePlatform, platformRoutes } from './modules/platform/routes';
import { localStorageRoutes } from './storage/local-routes';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

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

    const token = req.cookies[SESSION_COOKIE];
    const u = token ? await authenticateUser(deps, deps.pool, token) : null;
    if (!u) throw new AppError(401, 'unauthenticated', 'Sign in required');
    // A custom header can't be sent by a cross-site form; SameSite=Strict covers the rest.
    if (!SAFE_METHODS.has(req.method) && req.headers['x-rd-csrf'] !== '1') {
      throw new AppError(403, 'csrf_failed', 'Missing x-rd-csrf header');
    }
    if (!u.mfaVerified && !cfg.allowWithoutMfa) throw new AppError(403, 'mfa_required', 'Multi-factor authentication is required');
    req.user = u;
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
  await app.register(async (s) => platformRoutes(s, deps));
  await app.register(async (s) => localStorageRoutes(s, deps));
  return app;
}
