import type { LoginResponse, MfaEnrollResponse, OrgRole } from '@rd/contracts';
import type { Deps, DeviceActor, UserActor } from '../../context';
import { PRIVILEGED_ROLES } from '../../context';
import { one, type Queryable } from '../../db/pool';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  newTotpSecret,
  randomToken,
  sha256Hex,
  verifyPassword,
  verifyTotp,
} from '../../lib/crypto';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';

interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  org_role: OrgRole;
  status: 'active' | 'deactivated';
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
}

export function mustUseMfa(deps: Deps, role: OrgRole, mfaEnabled: boolean): boolean {
  return mfaEnabled || (deps.config.mfaRequiredForAdmins && PRIVILEGED_ROLES.includes(role));
}

export async function login(
  deps: Deps,
  q: Queryable,
  email: string,
  password: string,
  requestId?: string,
): Promise<{ token: string; response: LoginResponse }> {
  const user = await one<UserRow>(q, `SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || user.status !== 'active') {
    if (user) {
      // Outside the transaction: the throw below rolls it back, and failures must stay recorded.
      await audit(deps.pool, {
        organizationId: user.organization_id,
        actor: { kind: 'system' },
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        result: 'denied',
        requestId,
      });
    }
    throw errors.unauthenticated('Email or password is incorrect');
  }
  const needsMfa = mustUseMfa(deps, user.org_role, user.mfa_enabled);
  const token = randomToken();
  const expires = new Date(deps.now().getTime() + deps.config.sessionTtlHours * 3600_000);
  await q.query(
    `INSERT INTO user_sessions (user_id, organization_id, token_hash, mfa_verified, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [user.id, user.organization_id, sha256Hex(token), !needsMfa, expires.toISOString()],
  );
  await audit(q, {
    organizationId: user.organization_id,
    actor: { kind: 'system' },
    action: 'auth.login',
    targetType: 'user',
    targetId: user.id,
    requestId,
    metadata: { mfa_pending: needsMfa },
  });
  return { token, response: { mfa_required: needsMfa, mfa_enrolled: user.mfa_enabled } };
}

export async function authenticateUser(deps: Deps, q: Queryable, token: string): Promise<UserActor | null> {
  const r = await one<{
    session_id: string;
    mfa_verified: boolean;
    user_id: string;
    organization_id: string;
    org_role: OrgRole;
    display_name: string;
  }>(
    q,
    `SELECT s.id AS session_id, s.mfa_verified, u.id AS user_id, u.organization_id, u.org_role, u.display_name
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'active'`,
    [sha256Hex(token), deps.now().toISOString()],
  );
  if (!r) return null;
  return {
    kind: 'user',
    userId: r.user_id,
    organizationId: r.organization_id,
    orgRole: r.org_role,
    displayName: r.display_name,
    sessionId: r.session_id,
    mfaVerified: r.mfa_verified,
  };
}

export async function logout(q: Queryable, actor: UserActor): Promise<void> {
  await q.query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [actor.sessionId]);
}

export async function verifyMfa(deps: Deps, q: Queryable, actor: UserActor, code: string, requestId?: string): Promise<void> {
  const u = await one<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(
    q,
    'SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1',
    [actor.userId],
  );
  if (!u?.mfa_enabled || !u.mfa_secret_enc) throw errors.conflict('mfa_not_enrolled', 'Set up multi-factor authentication first');
  const ok = verifyTotp(decryptSecret(deps.config.appEncryptionKey, u.mfa_secret_enc), code, deps.now().getTime());
  await audit(ok ? q : deps.pool, {
    organizationId: actor.organizationId,
    actor,
    action: 'auth.mfa_verify',
    targetType: 'user',
    targetId: actor.userId,
    result: ok ? 'success' : 'denied',
    requestId,
  });
  if (!ok) throw errors.unauthenticated('The code is not valid');
  await q.query('UPDATE user_sessions SET mfa_verified = true WHERE id = $1', [actor.sessionId]);
}

export async function startMfaEnrollment(deps: Deps, q: Queryable, actor: UserActor): Promise<MfaEnrollResponse> {
  const u = await one<{ email: string; mfa_enabled: boolean }>(q, 'SELECT email, mfa_enabled FROM users WHERE id = $1', [
    actor.userId,
  ]);
  if (u?.mfa_enabled) throw errors.conflict('mfa_already_enrolled', 'Multi-factor authentication is already set up');
  const secret = newTotpSecret();
  await q.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [
    actor.userId,
    encryptSecret(deps.config.appEncryptionKey, secret),
  ]);
  const label = encodeURIComponent(`RoundDigital Track:${u!.email}`);
  return {
    secret_base32: secret,
    otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('RoundDigital Track')}&digits=6&period=30`,
  };
}

export async function confirmMfaEnrollment(deps: Deps, q: Queryable, actor: UserActor, code: string, requestId?: string) {
  const u = await one<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(
    q,
    'SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1',
    [actor.userId],
  );
  if (!u?.mfa_secret_enc || u.mfa_enabled) throw errors.conflict('mfa_enrollment_not_started', 'Start enrollment first');
  if (!verifyTotp(decryptSecret(deps.config.appEncryptionKey, u.mfa_secret_enc), code, deps.now().getTime())) {
    throw errors.validation('The code is not valid');
  }
  await q.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [actor.userId]);
  await q.query('UPDATE user_sessions SET mfa_verified = true WHERE id = $1', [actor.sessionId]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'auth.mfa_enrolled',
    targetType: 'user',
    targetId: actor.userId,
    requestId,
  });
}

export async function authenticateDevice(q: Queryable, credential: string): Promise<DeviceActor | 'revoked' | null> {
  const r = await one<{ id: string; user_id: string; organization_id: string; credential_status: string; user_status: string }>(
    q,
    `SELECT d.id, d.user_id, d.organization_id, d.credential_status, u.status AS user_status
     FROM devices d JOIN users u ON u.id = d.user_id WHERE d.credential_hash = $1`,
    [sha256Hex(credential)],
  );
  if (!r) return null;
  if (r.credential_status !== 'active' || r.user_status !== 'active') return 'revoked';
  return { kind: 'device', deviceId: r.id, userId: r.user_id, organizationId: r.organization_id };
}

export async function setPassword(q: Queryable, userId: string, password: string): Promise<void> {
  await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(password)]);
}
