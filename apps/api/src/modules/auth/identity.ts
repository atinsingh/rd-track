import { createHmac, randomInt } from 'node:crypto';
import {
  EMAIL_CHANGE_TTL_HOURS,
  INVITE_TTL_DAYS,
  PASSWORD_RESET_TTL_MINUTES,
  RECOVERY_CODE_COUNT,
  type AccountSecurity,
  type InviteInfo,
  type OrgRole,
} from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import type { EmailMessage } from '../../email/sender';
import { actionEmail } from '../../email/templates';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { publish } from '../engine/events';
import { notify } from '../engine/notify';
import { isValidTimeZone } from '../scheduling/tz';
import { mustUseMfa } from './service';

/**
 * Engine slice 2 (docs/design/07-product-review.md): invites, password reset, email change,
 * MFA recovery and the person's own account settings. Nobody is ever shown someone
 * else's password; every emailed link is single-use, expires, and is stored only hashed.
 */

type Purpose = 'invite' | 'password_reset' | 'email_change';

interface TokenRow {
  id: string;
  organization_id: string;
  user_id: string;
  data: Record<string, string>;
  expires_at: string;
}

const HOUR = 3600_000;

/** Issues a fresh link, cancelling any earlier unused one for the same person and purpose. */
async function issueToken(
  q: Queryable,
  p: { orgId: string; userId: string; purpose: Purpose; ttlMs: number; now: Date; createdBy?: string | null; data?: Record<string, string> },
): Promise<string> {
  await q.query(`UPDATE auth_tokens SET used_at = $3 WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [p.userId, p.purpose, p.now.toISOString()]);
  const raw = randomToken(32);
  await q.query(
    `INSERT INTO auth_tokens (organization_id, user_id, purpose, token_hash, data, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.orgId, p.userId, p.purpose, sha256Hex(raw), p.data ?? {}, p.createdBy ?? null, p.now.toISOString(), new Date(p.now.getTime() + p.ttlMs).toISOString()],
  );
  return raw;
}

async function peekToken(q: Queryable, purpose: Purpose, raw: string, now: Date): Promise<TokenRow | null> {
  return one<TokenRow>(
    q,
    `SELECT id, organization_id, user_id, data, expires_at FROM auth_tokens
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3`,
    [sha256Hex(raw), purpose, now.toISOString()],
  );
}

/** Marks the link used, exactly once. */
async function consumeToken(q: Queryable, purpose: Purpose, raw: string, now: Date): Promise<TokenRow | null> {
  return one<TokenRow>(
    q,
    `UPDATE auth_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
     RETURNING id, organization_id, user_id, data, expires_at`,
    [sha256Hex(raw), purpose, now.toISOString()],
  );
}

const invalidLink = (what: string) => new AppError(400, 'link_invalid', `This ${what} link is invalid, expired or already used.`);

async function orgName(q: Queryable, orgId: string): Promise<string> {
  return (await one<{ name: string }>(q, 'SELECT name FROM organizations WHERE id = $1', [orgId]))?.name ?? 'Your organization';
}

/** A signed-in session; privileged roles still go through MFA. */
export async function startUserSession(deps: Deps, q: Queryable, u: { id: string; organization_id: string; org_role: OrgRole; mfa_enabled: boolean }): Promise<string> {
  const token = randomToken();
  await q.query(
    `INSERT INTO user_sessions (user_id, organization_id, token_hash, mfa_verified, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [u.id, u.organization_id, sha256Hex(token), !mustUseMfa(deps, u.org_role, u.mfa_enabled), new Date(deps.now().getTime() + deps.config.sessionTtlHours * HOUR).toISOString()],
  );
  return token;
}

async function securityNotice(q: Queryable, orgId: string, userId: string, kind: string, title: string, body: string) {
  await notify(q, orgId, [userId], { kind, category: 'security', title, body, link: '/me/settings' });
}

// ───────────── invites (G1, G4) ─────────────

/**
 * Sends (or re-sends) an invite to someone who hasn't chosen a password yet. Returns the
 * email for the caller to send after commit.
 */
export async function inviteUser(deps: Deps, q: Queryable, p: { orgId: string; userId: string; invitedBy: UserActor | null; requestId?: string }): Promise<EmailMessage> {
  const u = await one<{ email: string; display_name: string; password_hash: string | null; status: string }>(
    q,
    'SELECT email, display_name, password_hash, status FROM users WHERE id = $1 AND organization_id = $2',
    [p.userId, p.orgId],
  );
  if (!u) throw errors.notFound('User');
  if (u.status !== 'active') throw errors.conflict('user_deactivated', 'Reactivate this person before inviting them');
  if (u.password_hash) throw errors.conflict('already_joined', 'This person has already joined');
  const now = deps.now();
  const raw = await issueToken(q, { orgId: p.orgId, userId: p.userId, purpose: 'invite', ttlMs: INVITE_TTL_DAYS * 24 * HOUR, now, createdBy: p.invitedBy?.userId });
  await q.query('UPDATE users SET invited_at = $2 WHERE id = $1', [p.userId, now.toISOString()]);
  await publish(q, { organizationId: p.orgId, type: 'user.invited', subjectUserId: p.userId, actorUserId: p.invitedBy?.userId ?? null });
  await audit(q, {
    organizationId: p.orgId,
    actor: p.invitedBy ?? { kind: 'system' },
    action: 'user.invite',
    targetType: 'user',
    targetId: p.userId,
    targetUserId: p.userId,
    requestId: p.requestId,
  });
  const org = await orgName(q, p.orgId);
  return actionEmail({
    to: u.email,
    orgName: org,
    title: `${p.invitedBy?.displayName ?? org} invited you to RoundDigital Track`,
    body: `Join ${org} on Track. Choose your password to sign in. Before anything is measured, you'll see exactly what is collected about you, and nothing is collected outside a work session you start.`,
    actionLabel: 'Accept the invite',
    url: `${deps.config.webUrl}/invite?token=${raw}`,
    expires: `in ${INVITE_TTL_DAYS} days`,
    ignore: "If you weren't expecting it, you can ignore this email.",
  });
}

export async function inviteInfo(deps: Deps, q: Queryable, raw: string): Promise<InviteInfo> {
  const t = await peekToken(q, 'invite', raw, deps.now());
  if (!t) throw invalidLink('invite');
  const u = await one<{ email: string; display_name: string; organization_name: string }>(
    q,
    `SELECT u.email, u.display_name, o.name AS organization_name FROM users u JOIN organizations o ON o.id = u.organization_id
     WHERE u.id = $1 AND u.status = 'active' AND u.password_hash IS NULL`,
    [t.user_id],
  );
  if (!u) throw invalidLink('invite');
  return { ...u, expires_at: t.expires_at };
}

/** Sets the person's own password and signs them in. */
export async function acceptInvite(
  deps: Deps,
  q: Queryable,
  input: { token: string; password: string; timezone?: string },
  requestId?: string,
): Promise<string> {
  const t = await consumeToken(q, 'invite', input.token, deps.now());
  if (!t) throw invalidLink('invite');
  const u = await one<{ id: string; organization_id: string; org_role: OrgRole; mfa_enabled: boolean }>(
    q,
    `UPDATE users SET password_hash = $2, timezone = COALESCE($3, timezone) WHERE id = $1 AND status = 'active' AND password_hash IS NULL
     RETURNING id, organization_id, org_role, mfa_enabled`,
    [t.user_id, await hashPassword(input.password), input.timezone && isValidTimeZone(input.timezone) ? input.timezone : null],
  );
  if (!u) throw invalidLink('invite');
  await audit(q, { organizationId: u.organization_id, actor: { kind: 'system' }, action: 'user.invite_accepted', targetType: 'user', targetId: u.id, targetUserId: u.id, requestId });
  return startUserSession(deps, q, u);
}

// ───────────── password reset (G3) ─────────────

/**
 * Always answers the same way. Someone who was invited but never joined gets their invite
 * again; an unknown or deactivated address gets nothing.
 */
export async function requestPasswordReset(deps: Deps, q: Queryable, email: string, requestId?: string): Promise<EmailMessage | null> {
  const u = await one<{ id: string; organization_id: string; email: string; password_hash: string | null }>(
    q,
    `SELECT id, organization_id, email, password_hash FROM users WHERE lower(email) = lower($1) AND status = 'active'`,
    [email],
  );
  if (!u) return null;
  if (!u.password_hash) return inviteUser(deps, q, { orgId: u.organization_id, userId: u.id, invitedBy: null, requestId });
  const raw = await issueToken(q, { orgId: u.organization_id, userId: u.id, purpose: 'password_reset', ttlMs: PASSWORD_RESET_TTL_MINUTES * 60_000, now: deps.now() });
  await audit(q, { organizationId: u.organization_id, actor: { kind: 'system' }, action: 'auth.password_reset_requested', targetType: 'user', targetId: u.id, targetUserId: u.id, requestId });
  return actionEmail({
    to: u.email,
    orgName: await orgName(q, u.organization_id),
    title: 'Reset your RoundDigital Track password',
    body: 'Someone (hopefully you) asked to reset the password for this account. Choose a new one with the link below; you will be signed out everywhere else.',
    actionLabel: 'Choose a new password',
    url: `${deps.config.webUrl}/reset?token=${raw}`,
    expires: `in ${PASSWORD_RESET_TTL_MINUTES} minutes`,
    ignore: "If you didn't ask, ignore this email; your password stays the same.",
  });
}

export async function confirmPasswordReset(deps: Deps, q: Queryable, input: { token: string; password: string }, requestId?: string): Promise<void> {
  const t = await consumeToken(q, 'password_reset', input.token, deps.now());
  if (!t) throw invalidLink('password reset');
  await q.query(`UPDATE users SET password_hash = $2 WHERE id = $1 AND status = 'active'`, [t.user_id, await hashPassword(input.password)]);
  await q.query('UPDATE user_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id, deps.now().toISOString()]);
  await audit(q, { organizationId: t.organization_id, actor: { kind: 'system' }, action: 'auth.password_reset', targetType: 'user', targetId: t.user_id, targetUserId: t.user_id, requestId });
  await securityNotice(q, t.organization_id, t.user_id, 'password_changed', 'Your password was changed', 'It was reset with an emailed link, and every other sign-in was ended. If this wasn’t you, contact your org admin now.');
}

// ───────────── MFA recovery (G5) ─────────────

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1

function newRecoveryCode(): string {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** Keyed hash: the codes are short, so a leaked table alone must not be enough to test guesses. */
function recoveryHash(deps: Deps, code: string): string {
  return createHmac('sha256', deps.config.appEncryptionKey).update(code.toLowerCase()).digest('hex');
}

/** Replaces any earlier codes with a fresh set, returned once. */
export async function issueRecoveryCodes(deps: Deps, q: Queryable, orgId: string, userId: string): Promise<string[]> {
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  for (const c of codes) {
    await q.query('INSERT INTO mfa_recovery_codes (organization_id, user_id, code_hash) VALUES ($1, $2, $3)', [orgId, userId, recoveryHash(deps, c)]);
  }
  return codes;
}

export async function regenerateRecoveryCodes(deps: Deps, q: Queryable, actor: UserActor, requestId?: string): Promise<string[]> {
  const u = await one<{ mfa_enabled: boolean }>(q, 'SELECT mfa_enabled FROM users WHERE id = $1', [actor.userId]);
  if (!u?.mfa_enabled) throw errors.conflict('mfa_not_enrolled', 'Set up multi-factor authentication first');
  if (!actor.mfaVerified) throw errors.mfaRequired();
  const codes = await issueRecoveryCodes(deps, q, actor.organizationId, actor.userId);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'auth.mfa_recovery_codes_issued', targetType: 'user', targetId: actor.userId, requestId });
  await securityNotice(q, actor.organizationId, actor.userId, 'recovery_codes', 'New recovery codes were created', 'Your earlier recovery codes no longer work.');
  return codes;
}

/** Completes the MFA step with a recovery code instead of the authenticator app. */
export async function verifyWithRecoveryCode(deps: Deps, q: Queryable, actor: UserActor, code: string, requestId?: string): Promise<number> {
  const used = await one<{ id: string }>(
    q,
    `UPDATE mfa_recovery_codes SET used_at = $3 WHERE id = (
       SELECT id FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)
     RETURNING id`,
    [actor.userId, recoveryHash(deps, code), deps.now().toISOString()],
  );
  await audit(used ? q : deps.pool, {
    organizationId: actor.organizationId,
    actor,
    action: 'auth.mfa_recovery_code',
    targetType: 'user',
    targetId: actor.userId,
    result: used ? 'success' : 'denied',
    requestId,
  });
  if (!used) throw errors.unauthenticated('That recovery code is not valid or was already used');
  await q.query('UPDATE user_sessions SET mfa_verified = true WHERE id = $1', [actor.sessionId]);
  const left = (await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [actor.userId]))!.n;
  await securityNotice(
    q,
    actor.organizationId,
    actor.userId,
    'recovery_code_used',
    'A recovery code was used to sign in',
    `${left} ${left === 1 ? 'code is' : 'codes are'} left. If you've lost your authenticator, create new codes in Settings.`,
  );
  return left;
}

/**
 * Another org admin turns MFA off for someone who lost their device. Needs the resetter's
 * own MFA; nobody resets their own. The person signs in again and sets MFA up afresh.
 */
export async function adminResetMfa(deps: Deps, q: Queryable, actor: UserActor, userId: string, requestId?: string): Promise<void> {
  if (!actor.mfaVerified && deps.config.mfaRequiredForAdmins) throw errors.mfaRequired();
  if (userId === actor.userId) throw errors.validation('Use a recovery code to reset your own multi-factor authentication');
  const u = await one<{ org_role: OrgRole; mfa_enabled: boolean }>(q, 'SELECT org_role, mfa_enabled FROM users WHERE id = $1 AND organization_id = $2', [userId, actor.organizationId]);
  if (!u) throw errors.notFound('User');
  if (u.org_role === 'super_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
  if (!u.mfa_enabled) throw errors.conflict('mfa_not_enrolled', 'This person has no multi-factor authentication to reset');
  await q.query('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1', [userId]);
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  await q.query('UPDATE user_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [userId, deps.now().toISOString()]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'user.mfa_reset', targetType: 'user', targetId: userId, targetUserId: userId, requestId });
  await securityNotice(
    q,
    actor.organizationId,
    userId,
    'mfa_reset',
    'Your multi-factor authentication was reset',
    `${actor.displayName} reset it and signed you out. Sign in again and set it up on your new device.`,
  );
}

// ───────────── my account (G13) ─────────────

export async function updateMe(q: Queryable, actor: UserActor, patch: { display_name?: string; timezone?: string }, requestId?: string): Promise<void> {
  if (patch.timezone && !isValidTimeZone(patch.timezone)) throw errors.validation('Unknown time zone');
  await q.query('UPDATE users SET display_name = COALESCE($2, display_name), timezone = COALESCE($3, timezone) WHERE id = $1', [
    actor.userId,
    patch.display_name ?? null,
    patch.timezone ?? null,
  ]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'user.update_self', targetType: 'user', targetId: actor.userId, targetUserId: actor.userId, requestId, metadata: { fields: Object.keys(patch) } });
}

async function assertPassword(q: Queryable, userId: string, password: string): Promise<{ email: string }> {
  const u = await one<{ email: string; password_hash: string | null }>(q, 'SELECT email, password_hash FROM users WHERE id = $1', [userId]);
  if (!u || !(await verifyPassword(password, u.password_hash))) throw new AppError(400, 'wrong_password', 'Your current password is not correct');
  return u;
}

/** Changes the password and ends every other sign-in. */
export async function changePassword(deps: Deps, q: Queryable, actor: UserActor, input: { current_password: string; new_password: string }, requestId?: string): Promise<void> {
  await assertPassword(q, actor.userId, input.current_password);
  await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [actor.userId, await hashPassword(input.new_password)]);
  await q.query('UPDATE user_sessions SET revoked_at = $3 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [actor.userId, actor.sessionId, deps.now().toISOString()]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'auth.password_changed', targetType: 'user', targetId: actor.userId, requestId });
  await securityNotice(q, actor.organizationId, actor.userId, 'password_changed', 'Your password was changed', 'Every other sign-in was ended. If this wasn’t you, reset your password now and tell your org admin.');
}

/** Sends a confirmation link to the new address and a heads-up to the current one. */
export async function requestEmailChange(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { new_email: string; current_password: string },
  requestId?: string,
): Promise<EmailMessage[]> {
  const me = await assertPassword(q, actor.userId, input.current_password);
  if (me.email.toLowerCase() === input.new_email.toLowerCase()) throw errors.validation('That is already your email address');
  if (await one(q, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.new_email])) {
    throw errors.conflict('email_taken', 'Another account uses that email address');
  }
  const raw = await issueToken(q, {
    orgId: actor.organizationId,
    userId: actor.userId,
    purpose: 'email_change',
    ttlMs: EMAIL_CHANGE_TTL_HOURS * HOUR,
    now: deps.now(),
    data: { new_email: input.new_email },
  });
  await audit(q, { organizationId: actor.organizationId, actor, action: 'user.email_change_requested', targetType: 'user', targetId: actor.userId, requestId });
  const org = await orgName(q, actor.organizationId);
  return [
    actionEmail({
      to: input.new_email,
      orgName: org,
      title: 'Confirm your new email address',
      body: `Confirm that you want to sign in to RoundDigital Track with this address instead of ${me.email}.`,
      actionLabel: 'Confirm this address',
      url: `${deps.config.webUrl}/email-change?token=${raw}`,
      expires: `in ${EMAIL_CHANGE_TTL_HOURS} hours`,
      ignore: "If you didn't ask for this, ignore this email; nothing changes.",
    }),
    {
      to: me.email,
      subject: 'Someone asked to change your RoundDigital Track email',
      text: `A request was made to change the email for your account to ${input.new_email}. Nothing changes until the new address is confirmed.\n\nIf this wasn't you, change your password now: ${deps.config.webUrl}/reset\n`,
    },
  ];
}

export async function confirmEmailChange(deps: Deps, q: Queryable, raw: string, requestId?: string): Promise<{ old: string; next: string }> {
  const t = await consumeToken(q, 'email_change', raw, deps.now());
  if (!t?.data.new_email) throw invalidLink('email change');
  const next = t.data.new_email;
  if (await one(q, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [next])) throw errors.conflict('email_taken', 'Another account now uses that email address');
  const before = await one<{ email: string }>(q, 'SELECT email FROM users WHERE id = $1', [t.user_id]);
  await q.query(`UPDATE users SET email = $2 WHERE id = $1 AND status = 'active'`, [t.user_id, next]);
  await audit(q, { organizationId: t.organization_id, actor: { kind: 'system' }, action: 'user.email_changed', targetType: 'user', targetId: t.user_id, targetUserId: t.user_id, requestId });
  await securityNotice(q, t.organization_id, t.user_id, 'email_changed', 'Your sign-in email was changed', `You now sign in with ${next}.`);
  return { old: before!.email, next };
}

export async function accountSecurity(deps: Deps, q: Queryable, actor: UserActor): Promise<AccountSecurity> {
  const u = await one<{ mfa_enabled: boolean }>(q, 'SELECT mfa_enabled FROM users WHERE id = $1', [actor.userId]);
  const codes = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [actor.userId]);
  const sessions = await one<{ n: number }>(
    q,
    'SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL AND expires_at > $3',
    [actor.userId, actor.sessionId, deps.now().toISOString()],
  );
  const pending = await many<{ data: { new_email?: string } }>(
    q,
    `SELECT data FROM auth_tokens WHERE user_id = $1 AND purpose = 'email_change' AND used_at IS NULL AND expires_at > $2`,
    [actor.userId, deps.now().toISOString()],
  );
  return {
    mfa_enabled: !!u?.mfa_enabled,
    recovery_codes_left: codes?.n ?? 0,
    other_sessions: sessions?.n ?? 0,
    pending_email: pending[0]?.data.new_email ?? null,
  };
}

/** Signs out everywhere except here. */
export async function signOutOthers(deps: Deps, q: Queryable, actor: UserActor, requestId?: string): Promise<number> {
  const r = await q.query('UPDATE user_sessions SET revoked_at = $3 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [actor.userId, actor.sessionId, deps.now().toISOString()]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'auth.signed_out_others', targetType: 'user', targetId: actor.userId, requestId });
  return r.rowCount ?? 0;
}
