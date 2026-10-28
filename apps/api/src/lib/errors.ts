/** An error with a stable code that maps to an HTTP status and the `{error:{…}}` body. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const errors = {
  validation: (message: string, details?: unknown) => new AppError(400, 'validation_failed', message, details),
  unauthenticated: (message = 'Sign in required') => new AppError(401, 'unauthenticated', message),
  deviceRevoked: () => new AppError(401, 'device_revoked', 'This device has been revoked'),
  paymentRequired: (message: string) => new AppError(402, 'plan_upgrade_required', message),
  forbidden: (message = 'You do not have access to this resource') => new AppError(403, 'forbidden', message),
  mfaRequired: () => new AppError(403, 'mfa_required', 'Multi-factor authentication is required'),
  subscriptionInactive: () =>
    new AppError(403, 'subscription_inactive', "Tracking is unavailable: your organization's subscription is inactive"),
  seatUnavailable: () => new AppError(403, 'seat_unavailable', 'No licence seat is assigned to this user'),
  notFound: (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  tooLarge: (message: string) => new AppError(413, 'payload_too_large', message),
};
