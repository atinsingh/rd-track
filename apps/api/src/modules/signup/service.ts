import { randomBytes } from 'node:crypto';
import type { Deps } from '../../context';
import { one, type Queryable } from '../../db/pool';
import { hashPassword, randomToken, sha256Hex } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { createOrganization } from '../platform/routes';

/**
 * Self-serve signup (commercial model §2): a 14-day Pro trial that exists only after the
 * email address is verified. Responses never reveal whether an email is registered.
 */

const TOKEN_TTL_MS = 24 * 3600_000;

export async function requestSignup(
  deps: Deps,
  q: Queryable,
  input: { org_name: string; display_name: string; email: string; password: string },
): Promise<{ to: string; subject: string; text: string }> {
  const existing = await one(q, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
  if (existing) {
    return {
      to: input.email,
      subject: 'You already have a RoundDigital Track account',
      text: `Someone (hopefully you) tried to create a new organization with this email address.\n\nYou already have an account — sign in at ${deps.config.webUrl}/login.\nIf this wasn't you, you can ignore this email.`,
    };
  }
  const token = randomToken(32);
  await q.query(
    `INSERT INTO signup_requests (email, display_name, org_name, password_hash, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.email,
      input.display_name,
      input.org_name,
      await hashPassword(input.password),
      sha256Hex(token),
      new Date(deps.now().getTime() + TOKEN_TTL_MS).toISOString(),
      deps.now().toISOString(),
    ],
  );
  return {
    to: input.email,
    subject: 'Confirm your RoundDigital Track account',
    text: `Welcome to RoundDigital Track.\n\nConfirm your email address to start a 14-day Pro trial for ${input.org_name}:\n${deps.config.webUrl}/signup/verify?token=${token}\n\nThe link expires in 24 hours. If you didn't sign up, ignore this email.`,
  };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

/** Verifies the token once and creates the organization (Pro trial) with its first admin. */
export async function completeSignup(deps: Deps, q: Queryable, token: string): Promise<{ userId: string; organizationId: string }> {
  const req = await one<{ id: string; email: string; display_name: string; org_name: string; password_hash: string }>(
    q,
    `UPDATE signup_requests SET completed_at = $2
     WHERE token_hash = $1 AND completed_at IS NULL AND expires_at > $2
     RETURNING id, email, display_name, org_name, password_hash`,
    [sha256Hex(token), deps.now().toISOString()],
  );
  if (!req) throw new AppError(400, 'signup_link_invalid', 'This link is invalid, expired or already used. Sign up again to get a new one.');
  const taken = await one(q, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [req.email]);
  if (taken) throw new AppError(400, 'signup_link_invalid', 'An account with this email already exists. Sign in instead.');

  const created = await createOrganization(
    deps,
    q,
    { name: req.org_name, slug: slugify(req.org_name), region: 'ca-central-1', admin_email: req.email, admin_name: req.display_name, seats: 0 },
    { kind: 'system' },
    // The person signing up usually tracks their own time too; that's one of the two free seats.
    { adminPasswordHash: req.password_hash, adminTracking: true },
  );
  await q.query('UPDATE signup_requests SET organization_id = $2 WHERE id = $1', [req.id, created.organization_id]);
  return { userId: created.admin_user_id, organizationId: created.organization_id };
}

/** Starts a signed-in session for the new admin (no MFA yet; they're prompted to enroll). */
export async function startSession(deps: Deps, q: Queryable, userId: string, organizationId: string): Promise<string> {
  const token = randomToken();
  await q.query(
    `INSERT INTO user_sessions (user_id, organization_id, token_hash, mfa_verified, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [userId, organizationId, sha256Hex(token), !deps.config.mfaRequiredForAdmins, new Date(deps.now().getTime() + deps.config.sessionTtlHours * 3600_000).toISOString()],
  );
  return token;
}
