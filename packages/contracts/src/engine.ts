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
  // Engine slice 3
  'timesheet.decided',
  'timesheet.due_soon',
  'timesheet.overdue',
  'timesheet.escalated',
  'time_off.requested',
  'time_off.decided',
  'user.invited',
  'user.deactivated',
  'device.stale',
  // Slice 5a
  'support_grant.requested',
  // Stage 4 F7
  'expense.submitted',
  'expense.decided',
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

// ───────────── work items (engine slice 3) ─────────────

/** What waits on the signed-in person as a reviewer; drives the nav badge. */
export interface InboxCounts {
  corrections: number;
  timesheets: number;
  time_off: number;
  /** Org admins only. */
  deletion_requests: number;
  expenses: number;
  total: number;
}

export const TODO_KINDS = ['submit_timesheet', 'resubmit_timesheet', 'allow_permission', 'open_agent', 'connect_computer'] as const;
export type TodoKind = (typeof TODO_KINDS)[number];

/** Something the person themselves should do; computed, so it disappears once done. */
export interface TodoDTO {
  id: string;
  kind: TodoKind;
  title: string;
  body: string;
  link: string;
  /** When it is due, if a rule sets one. */
  due_at: string | null;
  overdue: boolean;
}
export interface TodosResponse {
  items: TodoDTO[];
}

// ───────────── rules (engine slice 3) ─────────────

/**
 * Timesheet deadline: a week's timesheet is due on `due_weekday` (1 = Monday) of the
 * following week at `due_time`, in each person's own time zone. A reminder goes out the
 * working day before; the person is told when it is overdue; reviewers get one digest
 * `escalate_after_hours` later (0 = never). People with no tracked time that week are
 * never chased.
 */
export interface TimesheetRule {
  enabled: boolean;
  due_weekday: number;
  due_time: string;
  escalate_after_hours: number;
}
export const DEFAULT_TIMESHEET_RULE: TimesheetRule = { enabled: false, due_weekday: 1, due_time: '10:00', escalate_after_hours: 24 };
export const timesheetRuleUpdate = z.strictObject({
  enabled: z.boolean(),
  due_weekday: z.number().int().min(1).max(7),
  due_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  escalate_after_hours: z.number().int().min(0).max(168),
});

/** A computer that hasn't synced for this many working days gets a nudge to its owner. */
export const DEVICE_STALE_WORKING_DAYS = 3;

// ───────────── terms ─────────────

/** The version of the subscription terms and DPA a new organization accepts at signup. */
export const TERMS_VERSION = '2026-10-29';
