import { changePlanRequest, signupRequest, signupVerifyRequest } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { verifyStripeSignature } from '../billing/stripe';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { ADMIN_ROLES, SESSION_COOKIE, requireRole, setSessionCookie } from '../http';
import { parse } from '../lib/validate';
import { audit } from './audit/service';
import { applyStripeEvent, billingPortalUrl, changePlan, subscriptionDTO } from './billing/service';
import { completeSignup, requestSignup, startSession } from './signup/service';

/** Signup, plan changes and billing-provider webhooks (commercial model §2–§7). */
export async function commerceRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const limited = (max: number) => ({ config: { auth: 'public' as const, rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/v1/signup', limited(Math.max(5, deps.config.authRateLimitPerMinute)), async (req, reply) => {
    const body = parse(signupRequest, req.body);
    const message = await withTx(pool, (tx) => requestSignup(deps, tx, body));
    // Sent after commit; the same response whether or not the address already has an account.
    await deps.email.send(message);
    return reply.code(202).send({ ok: true });
  });

  app.post('/v1/signup/verify', limited(Math.max(10, deps.config.authRateLimitPerMinute)), async (req, reply) => {
    const { token } = parse(signupVerifyRequest, req.body);
    const session = await withTx(pool, async (tx) => {
      const { userId, organizationId } = await completeSignup(deps, tx, token);
      await audit(tx, {
        organizationId,
        actor: { kind: 'system' },
        action: 'organization.signup',
        targetType: 'organization',
        targetId: organizationId,
        targetUserId: userId,
        requestId: req.id,
      });
      return startSession(deps, tx, userId, organizationId);
    });
    setSessionCookie(reply, SESSION_COOKIE, session, deps.config.cookieSecure, deps.config.sessionTtlHours * 3600);
    return reply.code(201).send({ ok: true });
  });

  const user = { config: { auth: 'user' as const } };
  app.get('/v1/billing/subscription', user, async (req) => subscriptionDTO(pool, requireRole(req, ADMIN_ROLES).organizationId, deps.now()));
  app.post('/v1/billing/plan', user, async (req) => {
    const body = parse(changePlanRequest, req.body);
    return withTx(pool, (tx) => changePlan(deps, tx, requireRole(req, ADMIN_ROLES), body, req.id));
  });
  app.post('/v1/billing/portal', user, async (req) => ({ url: await billingPortalUrl(deps, pool, requireRole(req, ADMIN_ROLES)) }));

  // Stripe needs the exact raw bytes to verify the signature, so this scope parses JSON as text.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/v1/webhooks/billing/stripe', { config: { auth: 'public' } }, async (req) => {
      const header = req.headers['stripe-signature'];
      const event = verifyStripeSignature(
        req.body as string,
        Array.isArray(header) ? header[0] : header,
        deps.config.billing.stripe.webhookSecret,
        Math.floor(deps.now().getTime() / 1000),
      );
      const outcome = await withTx(pool, (tx) => applyStripeEvent(deps, tx, event));
      req.log.info({ event_type: event.type, outcome }, 'billing webhook');
      return { received: true };
    });
  });
}
