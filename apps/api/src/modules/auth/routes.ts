import {
  changeEmailRequest,
  changePasswordRequest,
  emailChangeConfirm,
  inviteAcceptRequest,
  loginRequest,
  mfaRecoveryRequest,
  mfaVerifyRequest,
  passwordResetConfirm,
  passwordResetRequest,
  updateMeRequest,
  type AccountSecurity,
  type InviteInfo,
  type Me,
  type RecoveryCodesResponse,
} from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../context';
import { one, withTx } from '../../db/pool';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie, userOf } from '../../http';
import { parse } from '../../lib/validate';
import { managedProjectIds, managedTeamIds } from '../authz';
import { subscriptionDTO } from '../billing/service';
import * as identity from './identity';
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

  app.post('/v1/auth/mfa/enroll/confirm', { config: { auth: 'user', allowWithoutMfa: true } }, async (req): Promise<RecoveryCodesResponse & { ok: true }> => {
    const { code } = parse(mfaVerifyRequest, req.body);
    const codes = await withTx(pool, (tx) => auth.confirmMfaEnrollment(deps, tx, userOf(req), code, req.id));
    return { ok: true, recovery_codes: codes };
  });

  // ───────── engine slice 2: links that arrive by email (public, rate limited) ─────────
  const limited = { config: { auth: 'public' as const, rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } };

  app.get<{ Params: { token: string } }>('/v1/invites/:token', limited, async (req): Promise<InviteInfo> => identity.inviteInfo(deps, pool, req.params.token));
  app.post('/v1/invites/accept', limited, async (req, reply) => {
    const body = parse(inviteAcceptRequest, req.body);
    const token = await withTx(pool, (tx) => identity.acceptInvite(deps, tx, body, req.id));
    setSessionCookie(reply, SESSION_COOKIE, token, deps.config.cookieSecure, deps.config.sessionTtlHours * 3600);
    return { ok: true };
  });
  app.post('/v1/auth/password-reset', limited, async (req, reply) => {
    const { email } = parse(passwordResetRequest, req.body);
    const message = await withTx(pool, (tx) => identity.requestPasswordReset(deps, tx, email, req.id));
    // Same answer whether or not the address has an account.
    if (message) await deps.email.send(message);
    return reply.code(202).send({ ok: true });
  });
  app.post('/v1/auth/password-reset/confirm', limited, async (req) => {
    const body = parse(passwordResetConfirm, req.body);
    await withTx(pool, (tx) => identity.confirmPasswordReset(deps, tx, body, req.id));
    return { ok: true };
  });
  app.post('/v1/auth/email-change/confirm', limited, async (req) => {
    const { token } = parse(emailChangeConfirm, req.body);
    const { old, next } = await withTx(pool, (tx) => identity.confirmEmailChange(deps, tx, token, req.id));
    await deps.email.send({
      to: old,
      subject: 'Your RoundDigital Track email was changed',
      text: `You now sign in with ${next}. If this wasn't you, contact your org admin now.\n`,
    });
    return { ok: true };
  });

  // ───────── MFA recovery ─────────
  app.post(
    '/v1/auth/mfa/recovery',
    { config: { auth: 'user', allowWithoutMfa: true, rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } },
    async (req) => {
      const { recovery_code } = parse(mfaRecoveryRequest, req.body);
      const left = await withTx(pool, (tx) => identity.verifyWithRecoveryCode(deps, tx, userOf(req), recovery_code, req.id));
      return { ok: true, recovery_codes_left: left };
    },
  );
  app.post('/v1/auth/mfa/recovery-codes', { config: { auth: 'user' } }, async (req): Promise<RecoveryCodesResponse> => ({
    recovery_codes: await withTx(pool, (tx) => identity.regenerateRecoveryCodes(deps, tx, userOf(req), req.id)),
  }));

  // ───────── my account ─────────
  app.patch('/v1/me', { config: { auth: 'user' } }, async (req) => {
    const body = parse(updateMeRequest, req.body);
    await withTx(pool, (tx) => identity.updateMe(tx, userOf(req), body, req.id));
    return { ok: true };
  });
  app.post('/v1/me/password', { config: { auth: 'user', rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(changePasswordRequest, req.body);
    await withTx(pool, (tx) => identity.changePassword(deps, tx, userOf(req), body, req.id));
    return { ok: true };
  });
  app.post('/v1/me/email', { config: { auth: 'user', rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(changeEmailRequest, req.body);
    const messages = await withTx(pool, (tx) => identity.requestEmailChange(deps, tx, userOf(req), body, req.id));
    for (const m of messages) await deps.email.send(m);
    return reply.code(202).send({ ok: true });
  });
  app.get('/v1/me/security', { config: { auth: 'user' } }, async (req): Promise<AccountSecurity> => identity.accountSecurity(deps, pool, userOf(req)));
  app.post('/v1/me/sessions/sign-out-others', { config: { auth: 'user' } }, async (req) => ({
    signed_out: await withTx(pool, (tx) => identity.signOutOthers(deps, tx, userOf(req), req.id)),
  }));

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
