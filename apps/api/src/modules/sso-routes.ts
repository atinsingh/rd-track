import {
  scimTokenRequest,
  ssoConnectionRequest,
  ssoDiscoverRequest,
  ssoDomainRequest,
  ssoOptionsRequest,
  type ScimTokenDTO,
  type SsoDiscoverResponse,
  type SsoDomainDTO,
  type SsoSettings,
  type SsoStartResponse,
} from '@rd/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, requireRole, SESSION_COOKIE, setSessionCookie } from '../http';
import { randomToken } from '../lib/crypto';
import { parse } from '../lib/validate';
import { audit } from './audit/service';
import { createSession } from './auth/service';
import { createScimToken, revokeScimToken } from './scim/service';
import { spFor, spMetadata } from './sso/saml';
import * as sso from './sso/service';

/** Ties a sign-in at the identity provider to the browser that started it. */
const BROWSER_COOKIE = 'rd_sso';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Lands the browser on `to` with a same-site navigation. A plain redirect would still count
 * as cross-site (it started at the identity provider), so the SameSite=Strict session
 * cookie wouldn't be sent with it.
 */
function land(reply: FastifyReply, to: string) {
  const url = escapeHtml(to);
  return reply
    .code(200)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'")
    .header('referrer-policy', 'no-referrer')
    .send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><title>Signing in…</title><p>Signing in… <a href="${url}">Continue</a></p>`);
}

export async function ssoRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const admin = (req: Parameters<typeof requireRole>[0]) => requireRole(req, ADMIN_ROLES);
  const limited = { config: { auth: 'public' as const, rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } };
  const browserCookie = (reply: FastifyReply) => {
    const value = randomToken();
    // Lax: it has to come back on the top-level GET from the identity provider.
    reply.setCookie(BROWSER_COOKIE, value, { httpOnly: true, secure: deps.config.cookieSecure, sameSite: 'lax', path: '/v1/auth/sso', maxAge: 600 });
    return value;
  };

  // ───────── signing in (public) ─────────
  app.post('/v1/auth/sso/discover', limited, async (req): Promise<SsoDiscoverResponse> => {
    const { email } = parse(ssoDiscoverRequest, req.body);
    return sso.discoverSignIn(deps, pool, email);
  });
  app.post('/v1/auth/sso/start', limited, async (req, reply): Promise<SsoStartResponse> => {
    const { email, return_to } = parse(ssoDiscoverRequest, req.body);
    const browser = browserCookie(reply);
    return { redirect_url: await withTx(pool, (tx) => sso.startSignIn(deps, tx, email, browser, return_to)) };
  });
  /** Ends a sign-in at the identity provider: a session (or a passed test), or back to where the failure is explained. */
  const finish = async (req: FastifyRequest, reply: FastifyReply, complete: (tx: PoolClient, browser: string | undefined) => Promise<sso.CallbackResult>) => {
    const browser = req.cookies[BROWSER_COOKIE];
    reply.clearCookie(BROWSER_COOKIE, { path: '/v1/auth/sso' });
    try {
      const r = await withTx(pool, async (tx) => {
        const done = await complete(tx, browser);
        if (done.kind === 'tested') return { to: '/admin/sso?test=ok' };
        const token = await createSession(deps, tx, done.userId, done.orgId, true);
        await audit(tx, { organizationId: done.orgId, actor: { kind: 'system' }, action: 'auth.login', targetType: 'user', targetId: done.userId, targetUserId: done.userId, requestId: req.id, metadata: { via: 'sso' } });
        return { to: done.returnTo, token };
      });
      if (r.token) setSessionCookie(reply, SESSION_COOKIE, r.token, deps.config.cookieSecure, deps.config.sessionTtlHours * 3600);
      return land(reply, r.to);
    } catch (e) {
      if (e instanceof sso.SsoFailure) {
        req.log.info({ sso: e.code, detail: e.message }, 'sso sign-in failed');
        return land(reply, e.test ? `/admin/sso?test_error=${e.code}` : `/login?sso_error=${e.code}`);
      }
      throw e;
    }
  };

  // OpenID Connect: the provider sends the browser back here with a code.
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/auth/sso/callback', limited, async (req, reply) => {
    const q = req.query;
    return finish(req, reply, (tx, browser) => sso.completeSignIn(deps, tx, { state: q.state, code: q.code, error: q.error, browser }, req.id));
  });

  // SAML: Track's metadata, for the organization's provider to import. Its URL is also Track's entity ID.
  app.get<{ Params: { orgId: string } }>('/v1/auth/sso/saml/:orgId', limited, async (req, reply) => {
    const orgId = parse(z.uuid(), req.params.orgId);
    return reply
      .header('content-type', 'application/samlmetadata+xml; charset=utf-8')
      .header('content-disposition', 'inline; filename="rd-track-saml.xml"')
      .send(spMetadata(spFor(deps.config.webUrl, orgId)));
  });

  // SAML answers arrive as a cross-site form post: accept that body type on this route only.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.post<{ Params: { orgId: string }; Body: Record<string, string | undefined> }>('/v1/auth/sso/saml/:orgId/acs', limited, async (req, reply) => {
    const orgId = parse(z.uuid(), req.params.orgId);
    const body = req.body ?? {};
    const relayState = typeof body.RelayState === 'string' ? body.RelayState : undefined;
    const ok = await withTx(pool, (tx) => sso.receiveSamlResponse(deps, tx, orgId, { relayState, samlResponse: body.SAMLResponse }, req.id));
    // Sign-ins started from the provider's app list aren't accepted: nothing ties them to a browser.
    if (!ok) return land(reply, `/login?sso_error=${relayState ? 'expired' : 'start_in_track'}`);
    // The browser cookie wasn't sent with the cross-site post; it is with this same-site GET.
    return reply.redirect(`/v1/auth/sso/saml/finish?${new URLSearchParams({ state: relayState! })}`, 303);
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/auth/sso/saml/finish', limited, async (req, reply) =>
    finish(req, reply, (tx, browser) => sso.completeSamlSignIn(deps, tx, { state: req.query.state, browser }, req.id)),
  );

  // ───────── settings (org admin) ─────────
  app.get('/v1/admin/sso', user, async (req): Promise<SsoSettings> => sso.ssoSettings(deps, pool, admin(req).organizationId));
  app.put('/v1/admin/sso/connection', user, async (req): Promise<SsoSettings> => {
    const a = admin(req);
    const body = parse(ssoConnectionRequest, req.body);
    await withTx(pool, (tx) => sso.saveConnection(deps, tx, a, body, req.id));
    return sso.ssoSettings(deps, pool, a.organizationId);
  });
  app.delete('/v1/admin/sso/connection', user, async (req): Promise<SsoSettings> => {
    const a = admin(req);
    await withTx(pool, (tx) => sso.deleteConnection(tx, a, req.id));
    return sso.ssoSettings(deps, pool, a.organizationId);
  });
  app.patch('/v1/admin/sso', user, async (req): Promise<SsoSettings> => {
    const a = admin(req);
    const body = parse(ssoOptionsRequest, req.body);
    await withTx(pool, (tx) => sso.setSsoOptions(deps, tx, a, body, req.id));
    return sso.ssoSettings(deps, pool, a.organizationId);
  });
  app.post('/v1/admin/sso/test', user, async (req, reply): Promise<SsoStartResponse> => {
    const a = admin(req);
    const browser = browserCookie(reply);
    return { redirect_url: await withTx(pool, (tx) => sso.startTest(deps, tx, a, browser)) };
  });
  app.post('/v1/admin/sso/domains', user, async (req, reply) => {
    const a = admin(req);
    const { domain } = parse(ssoDomainRequest, req.body);
    const d: SsoDomainDTO = await withTx(pool, (tx) => sso.addDomain(deps, tx, a, domain, req.id));
    return reply.code(201).send(d);
  });
  app.post<{ Params: { id: string } }>('/v1/admin/sso/domains/:id/verify', user, async (req): Promise<SsoDomainDTO> => {
    const a = admin(req);
    return withTx(pool, (tx) => sso.verifyDomain(deps, tx, a, parse(z.uuid(), req.params.id), req.id));
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/sso/domains/:id', user, async (req) => {
    const a = admin(req);
    await withTx(pool, (tx) => sso.removeDomain(tx, a, parse(z.uuid(), req.params.id), req.id));
    return { ok: true };
  });

  // ───────── directory tokens (SCIM, 6b) ─────────
  app.post('/v1/admin/scim-tokens', user, async (req, reply) => {
    const a = admin(req);
    const { label } = parse(scimTokenRequest, req.body);
    const t: ScimTokenDTO & { token: string } = await withTx(pool, (tx) => createScimToken(deps, tx, a, label, req.id));
    return reply.code(201).send(t);
  });
  app.delete<{ Params: { id: string } }>('/v1/admin/scim-tokens/:id', user, async (req) => {
    const a = admin(req);
    await withTx(pool, (tx) => revokeScimToken(deps, tx, a, parse(z.uuid(), req.params.id), req.id));
    return { ok: true };
  });
}
