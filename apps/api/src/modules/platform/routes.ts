import { PLAN_IDS, TRIAL_DAYS, loginRequest, mfaVerifyRequest } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps, PlatformActor } from '../../context';
import { many, one, withTx, type Queryable } from '../../db/pool';
import { PLATFORM_COOKIE, platformOf, setSessionCookie } from '../../http';
import { decryptSecret, hashPassword, randomToken, sha256Hex, verifyPassword, verifyTotp } from '../../lib/crypto';
import { errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { seatCounts } from '../billing/service';

/**
 * Vendor operator realm (commercial model §5). Operators manage tenants and
 * subscriptions; nothing here reads tenant activity, apps or screenshots.
 */

const createOrgRequest = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]{2,63}$/),
  region: z.string().max(50).default('ca-central-1'),
  admin_email: z.email(),
  admin_name: z.string().min(1).max(200),
  /** Start on a 14-day Pro trial (default) or directly on a plan. */
  plan: z.enum(PLAN_IDS).optional(),
  seats: z.number().int().min(0).default(0),
});

const subscriptionPatch = z.strictObject({
  plan: z.enum(PLAN_IDS).optional(),
  seats: z.number().int().min(0).optional(),
  status: z.enum(['trialing', 'active', 'past_due', 'grace', 'inactive', 'canceled']).optional(),
  price_per_seat_cents: z.number().int().min(0).nullable().optional(),
});

export async function authenticatePlatform(deps: Deps, q: Queryable, token: string): Promise<PlatformActor | null> {
  const r = await one<{ platform_admin_id: string; mfa_verified: boolean }>(
    q,
    `SELECT platform_admin_id, mfa_verified FROM platform_sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [sha256Hex(token), deps.now().toISOString()],
  );
  return r ? { kind: 'platform', platformAdminId: r.platform_admin_id, mfaVerified: r.mfa_verified } : null;
}

/** Creates a tenant with its first org admin; used by the platform API and the seed script. */
export async function createOrganization(
  deps: Deps,
  q: Queryable,
  input: z.infer<typeof createOrgRequest>,
  actor: PlatformActor | { kind: 'system' },
): Promise<{ organization_id: string; admin_user_id: string; admin_initial_password: string }> {
  const exists = await one(q, 'SELECT 1 FROM organizations WHERE slug = $1', [input.slug]);
  if (exists) throw errors.conflict('slug_taken', 'An organization with this slug already exists');
  const o = await one<{ id: string }>(q, 'INSERT INTO organizations (name, slug, region) VALUES ($1, $2, $3) RETURNING id', [
    input.name,
    input.slug,
    input.region,
  ]);
  const now = deps.now();
  const trial = input.plan === undefined;
  await q.query(
    `INSERT INTO subscriptions (organization_id, plan, status, seats, trial_ends_at, current_period_start)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      o!.id,
      trial ? 'pro' : input.plan,
      trial ? 'trialing' : 'active',
      input.seats,
      trial ? new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString() : null,
      now.toISOString(),
    ],
  );
  const password = randomToken(12);
  // The first admin doesn't track time by default: viewer seats are free.
  const u = await one<{ id: string }>(
    q,
    `INSERT INTO users (organization_id, email, display_name, password_hash, org_role, tracking_enabled)
     VALUES ($1, $2, $3, $4, 'org_admin', false) RETURNING id`,
    [o!.id, input.admin_email, input.admin_name, await hashPassword(password)],
  );
  await audit(q, {
    organizationId: o!.id,
    actor,
    action: 'organization.create',
    targetType: 'organization',
    targetId: o!.id,
    metadata: { plan: trial ? 'pro_trial' : input.plan },
  });
  return { organization_id: o!.id, admin_user_id: u!.id, admin_initial_password: password };
}

export async function platformRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const platform = { config: { auth: 'platform' as const } };
  const verified = (req: Parameters<typeof platformOf>[0]) => {
    const p = platformOf(req);
    if (!p.mfaVerified) throw errors.mfaRequired();
    return p;
  };

  app.post(
    '/platform/v1/auth/login',
    { config: { auth: 'public', rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(loginRequest, req.body);
      const a = await one<{ id: string; password_hash: string; mfa_enabled: boolean }>(
        pool,
        'SELECT id, password_hash, mfa_enabled FROM platform_admins WHERE lower(email) = lower($1)',
        [body.email],
      );
      if (!(await verifyPassword(body.password, a?.password_hash ?? null)) || !a) throw errors.unauthenticated('Email or password is incorrect');
      const token = randomToken();
      await pool.query(
        `INSERT INTO platform_sessions (platform_admin_id, token_hash, mfa_verified, expires_at) VALUES ($1, $2, false, $3)`,
        [a.id, sha256Hex(token), new Date(deps.now().getTime() + 8 * 3600_000).toISOString()],
      );
      setSessionCookie(reply, PLATFORM_COOKIE, token, deps.config.cookieSecure, 8 * 3600);
      return { mfa_required: true, mfa_enrolled: a.mfa_enabled };
    },
  );

  app.post('/platform/v1/auth/mfa/verify', { config: { auth: 'platform', rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const p = platformOf(req);
    const { code } = parse(mfaVerifyRequest, req.body);
    const a = await one<{ mfa_secret_enc: string | null }>(pool, 'SELECT mfa_secret_enc FROM platform_admins WHERE id = $1', [p.platformAdminId]);
    if (!a?.mfa_secret_enc || !verifyTotp(decryptSecret(deps.config.appEncryptionKey, a.mfa_secret_enc), code, deps.now().getTime())) {
      throw errors.unauthenticated('The code is not valid');
    }
    await pool.query(`UPDATE platform_sessions SET mfa_verified = true WHERE platform_admin_id = $1 AND token_hash = $2`, [
      p.platformAdminId,
      sha256Hex(req.cookies[PLATFORM_COOKIE] ?? ''),
    ]);
    return { ok: true };
  });

  app.get('/platform/v1/organizations', platform, async (req) => {
    verified(req);
    const orgs = await many<{ id: string; name: string; slug: string; region: string; plan: string; status: string; seats: number; created_at: string }>(
      pool,
      `SELECT o.id, o.name, o.slug, o.region, s.plan, s.status, s.seats, o.created_at
       FROM organizations o JOIN subscriptions s ON s.organization_id = o.id ORDER BY o.created_at DESC`,
    );
    const items = [];
    for (const o of orgs) items.push({ ...o, ...(await seatCounts(pool, o.id)) });
    return { items };
  });

  app.post('/platform/v1/organizations', platform, async (req, reply) => {
    const actor = verified(req);
    const body = parse(createOrgRequest, req.body);
    return reply.code(201).send(await withTx(pool, (tx) => createOrganization(deps, tx, body, actor)));
  });

  app.patch<{ Params: { id: string } }>('/platform/v1/organizations/:id/subscription', platform, async (req) => {
    const actor = verified(req);
    const body = parse(subscriptionPatch, req.body);
    return withTx(pool, async (tx) => {
      const r = await one(
        tx,
        `UPDATE subscriptions SET plan = COALESCE($2, plan), seats = COALESCE($3, seats), status = COALESCE($4, status),
           price_per_seat_cents = CASE WHEN $5::boolean THEN $6 ELSE price_per_seat_cents END,
           grace_ends_at = CASE WHEN $4 IN ('active', 'trialing') THEN NULL ELSE grace_ends_at END, updated_at = now()
         WHERE organization_id = $1 RETURNING *`,
        [
          req.params.id,
          body.plan ?? null,
          body.seats ?? null,
          body.status ?? null,
          body.price_per_seat_cents !== undefined,
          body.price_per_seat_cents ?? null,
        ],
      );
      if (!r) throw errors.notFound('Organization');
      await audit(tx, {
        organizationId: req.params.id,
        actor,
        action: 'platform.subscription_changed',
        targetType: 'subscription',
        targetId: req.params.id,
        metadata: body,
      });
      return r;
    });
  });
}

export async function createPlatformAdmin(q: Queryable, email: string, name: string, password: string, mfaSecretEnc: string) {
  await q.query(
    `INSERT INTO platform_admins (email, display_name, password_hash, mfa_secret_enc, mfa_enabled) VALUES ($1, $2, $3, $4, true)`,
    [email, name, await hashPassword(password), mfaSecretEnc],
  );
}
