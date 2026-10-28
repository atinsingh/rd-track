import { loginRequest, mfaVerifyRequest, type Me } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../context';
import { one, withTx } from '../../db/pool';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie, userOf } from '../../http';
import { parse } from '../../lib/validate';
import { managedProjectIds, managedTeamIds } from '../authz';
import { subscriptionDTO } from '../billing/service';
import * as auth from './service';

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;

  app.post(
    '/v1/auth/login',
    { config: { auth: 'public', rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(loginRequest, req.body);
      const { token, response } = await withTx(pool, (tx) => auth.login(deps, tx, body.email, body.password, req.id));
      setSessionCookie(reply, SESSION_COOKIE, token, deps.config.cookieSecure, deps.config.sessionTtlHours * 3600);
      return response;
    },
  );

  app.post('/v1/auth/logout', { config: { auth: 'user', allowWithoutMfa: true } }, async (req, reply) => {
    await auth.logout(pool, userOf(req));
    clearSessionCookie(reply, SESSION_COOKIE);
    return { ok: true };
  });

  app.post(
    '/v1/auth/mfa/verify',
    { config: { auth: 'user', allowWithoutMfa: true, rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } },
    async (req) => {
      const { code } = parse(mfaVerifyRequest, req.body);
      await withTx(pool, (tx) => auth.verifyMfa(deps, tx, userOf(req), code, req.id));
      return { ok: true };
    },
  );

  app.post('/v1/auth/mfa/enroll', { config: { auth: 'user', allowWithoutMfa: true } }, async (req) =>
    auth.startMfaEnrollment(deps, pool, userOf(req)),
  );

  app.post('/v1/auth/mfa/enroll/confirm', { config: { auth: 'user', allowWithoutMfa: true } }, async (req) => {
    const { code } = parse(mfaVerifyRequest, req.body);
    await withTx(pool, (tx) => auth.confirmMfaEnrollment(deps, tx, userOf(req), code, req.id));
    return { ok: true };
  });

  app.get('/v1/me', { config: { auth: 'user', allowWithoutMfa: true } }, async (req): Promise<Me> => {
    const actor = userOf(req);
    const u = await one<{
      id: string;
      email: string;
      display_name: string;
      org_role: Me['user']['org_role'];
      timezone: string;
      tracking_enabled: boolean;
      mfa_enabled: boolean;
      org_name: string;
    }>(
      pool,
      `SELECT u.id, u.email, u.display_name, u.org_role, u.timezone, u.tracking_enabled, u.mfa_enabled, o.name AS org_name
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1`,
      [actor.userId],
    );
    const sub = await subscriptionDTO(pool, actor.organizationId, deps.now());
    const { org_name, ...user } = u!;
    return {
      user,
      organization: { id: actor.organizationId, name: org_name, plan: sub.plan, license: sub.license },
      mfa_verified: actor.mfaVerified,
      managed_team_ids: await managedTeamIds(pool, actor.userId),
      managed_project_ids: await managedProjectIds(pool, actor.userId),
      entitlements: sub.entitlements,
    };
  });
}
