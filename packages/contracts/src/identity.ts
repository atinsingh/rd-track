import { z } from 'zod';

/**
 * Engine slice 2: invites, password reset, email change, MFA recovery and the person's
 * own account settings (docs/design/07-product-review.md, G1 G3 G4 G5 G13).
 */

const password = z.string().min(12, 'Use at least 12 characters.').max(200);
const token = z.string().min(20).max(200);

/** Lifetimes of emailed links. */
export const INVITE_TTL_DAYS = 7;
export const PASSWORD_RESET_TTL_MINUTES = 60;
export const EMAIL_CHANGE_TTL_HOURS = 24;
export const RECOVERY_CODE_COUNT = 10;

// ───────────── invites ─────────────

export interface InviteInfo {
  email: string;
  display_name: string;
  organization_name: string;
  expires_at: string;
}
export const inviteAcceptRequest = z.strictObject({
  token,
  password,
  timezone: z.string().min(1).max(64).optional(),
});

// ───────────── password reset ─────────────

export const passwordResetRequest = z.strictObject({ email: z.email().max(320) });
export const passwordResetConfirm = z.strictObject({ token, password });

// ───────────── MFA ─────────────

/** Recovery codes look like "k7m2-9qxd": 8 characters from an unambiguous alphabet. */
export const RECOVERY_CODE_PATTERN = /^[a-z2-9]{4}-[a-z2-9]{4}$/;
export const mfaRecoveryRequest = z.strictObject({ recovery_code: z.string().trim().toLowerCase().regex(RECOVERY_CODE_PATTERN) });
export interface RecoveryCodesResponse {
  /** Shown once; only hashes are stored. */
  recovery_codes: string[];
}

// ───────────── my account ─────────────

export const updateMeRequest = z.strictObject({
  display_name: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().min(1).max(64).optional(),
});
export const changePasswordRequest = z.strictObject({ current_password: z.string().min(1).max(200), new_password: password });
export const changeEmailRequest = z.strictObject({ new_email: z.email().max(320), current_password: z.string().min(1).max(200) });
export const emailChangeConfirm = z.strictObject({ token });

export interface AccountSecurity {
  mfa_enabled: boolean;
  /** Unused recovery codes left (0 when MFA is off). */
  recovery_codes_left: number;
  /** Another browser or computer is signed in. */
  other_sessions: number;
  /** An email change waiting for confirmation from the new address. */
  pending_email: string | null;
}
