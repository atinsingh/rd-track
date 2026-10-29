import { z } from 'zod';

/**
 * The product engine (docs/design/07-product-review.md §3): domain events written in the
 * same transaction as the change, and the notifications they fan out to.
 */

// ───────────── domain events ─────────────

export const DOMAIN_EVENT_TYPES = [
  'correction.submitted',
  'correction.decided',
  'timesheet.submitted',
  'deletion_request.decided',
  'deletion_request.completed',
  'device.revoked',
  'device.permission_missing',
  'billing.trial_ending',
  'billing.payment_failed',
  'billing.grace_ending',
  'billing.inactive',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

// ───────────── notifications ─────────────

/**
 * What a notification is about. People choose in-app and email per category, except
 * the mandatory ones: changes to what is collected about you, the result of your own
 * deletion requests, security, and (for admins) billing that can stop tracking.
 */
export const NOTIFICATION_CATEGORIES = ['approvals', 'my_requests', 'schedule', 'budgets', 'devices', 'privacy', 'billing', 'security'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const MANDATORY_CATEGORIES: readonly NotificationCategory[] = ['privacy', 'billing', 'security'];

/** Defaults when a person hasn't chosen: everything in-app; email for what needs action or is about you. */
export const NOTIFICATION_DEFAULTS: Record<NotificationCategory, { in_app: boolean; email: boolean }> = {
  approvals: { in_app: true, email: true },
  my_requests: { in_app: true, email: true },
  schedule: { in_app: true, email: false },
  budgets: { in_app: true, email: true },
  devices: { in_app: true, email: true },
  privacy: { in_app: true, email: true },
  billing: { in_app: true, email: true },
  security: { in_app: true, email: true },
};

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, { label: string; hint: string }> = {
  approvals: { label: 'Waiting for your review', hint: 'Corrections, timesheets and time off from your team' },
  my_requests: { label: 'Decisions on your requests', hint: 'Your corrections, timesheets and time off' },
  schedule: { label: 'Schedule and balances', hint: 'Shift changes and time-off balance adjustments' },
  budgets: { label: 'Project budgets', hint: 'When a project you manage nears or reaches its budget' },
  devices: { label: 'Your computers', hint: 'An agent lost a permission or was disconnected' },
  privacy: { label: 'Your data', hint: 'Changes to what is collected about you, and your deletion requests' },
  billing: { label: 'Billing', hint: 'Trial ending, failed payments, and anything that would stop tracking' },
  security: { label: 'Security', hint: 'Sign-in and account changes' },
};

export interface NotificationDTO {
  id: string;
  kind: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** In-app path to act on it, e.g. "/approvals". */
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationsResponse {
  items: NotificationDTO[];
  unread: number;
}

export interface NotificationPreference {
  category: NotificationCategory;
  in_app: boolean;
  email: boolean;
  /** Can't be turned off. */
  mandatory: boolean;
}
export interface NotificationPreferencesResponse {
  items: NotificationPreference[];
}
export const notificationPreferencesUpdate = z.strictObject({
  items: z
    .array(z.strictObject({ category: z.enum(NOTIFICATION_CATEGORIES), in_app: z.boolean(), email: z.boolean() }))
    .min(1)
    .max(NOTIFICATION_CATEGORIES.length),
});

// ───────────── terms ─────────────

/** The version of the subscription terms and DPA a new organization accepts at signup. */
export const TERMS_VERSION = '2026-10-29';
