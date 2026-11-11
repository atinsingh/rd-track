import type { DomainEventType, WebhookEventType } from '@rd/contracts';
import type { Lang } from '../../i18n';
import { many, one, type Queryable } from '../../db/pool';
import { emitEvent } from '../webhooks/service';
import { notify, type NotificationInput } from './notify';

/**
 * Domain events (docs/design/07-product-review.md §3). `publish` writes the event in the
 * caller's transaction and runs its reactions there too, so nobody hears about a change
 * that rolled back. Reactions only write rows and queue jobs (email, webhooks); anything
 * slow happens in the worker.
 */

export interface DomainEventInput {
  organizationId: string;
  type: DomainEventType;
  data?: Record<string, unknown>;
  /** The person the event is about (the requester, the device's user…). */
  subjectUserId?: string | null;
  actorUserId?: string | null;
  /** Makes a milestone happen once, e.g. `trial_ending:7:<trial end>`. */
  dedupeKey?: string | null;
}

interface DomainEvent extends Required<Omit<DomainEventInput, 'data'>> {
  id: string;
  data: Record<string, unknown>;
}

/** Returns the event id, or null when the dedupe key says it already happened. */
export async function publish(q: Queryable, e: DomainEventInput): Promise<string | null> {
  const row = await one<{ id: string }>(
    q,
    `INSERT INTO domain_events (organization_id, type, subject_user_id, actor_user_id, data, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (organization_id, dedupe_key) DO NOTHING RETURNING id`,
    [e.organizationId, e.type, e.subjectUserId ?? null, e.actorUserId ?? null, e.data ?? {}, e.dedupeKey ?? null],
  );
  if (!row) return null;
  const event: DomainEvent = {
    id: row.id,
    organizationId: e.organizationId,
    type: e.type,
    data: e.data ?? {},
    subjectUserId: e.subjectUserId ?? null,
    actorUserId: e.actorUserId ?? null,
    dedupeKey: e.dedupeKey ?? null,
  };
  await notifyFor(q, event);
  await webhookFor(q, event);
  return row.id;
}

/**
 * Engine events that integrations can subscribe to. Payloads carry ids and dates only —
 * never activity, app names or anything typed (INT-03).
 */
async function webhookFor(q: Queryable, e: DomainEvent): Promise<void> {
  const d = e.data;
  const who = { user_id: e.subjectUserId };
  const send = (type: WebhookEventType, data: Record<string, unknown>) => emitEvent(q, e.organizationId, type, { ...who, ...data });
  switch (e.type) {
    case 'correction.submitted':
      return void (await send('time_correction.submitted', { correction_id: d.correction_id }));
    case 'correction.decided':
      // Approvals are emitted by the corrections module with the approved times.
      if (!d.approved) await send('time_correction.rejected', { correction_id: d.correction_id });
      return;
    case 'timesheet.submitted':
      return void (await send('timesheet.submitted', { timesheet_id: d.timesheet_id, period_start: d.period_start }));
    case 'timesheet.decided':
      return void (await send(d.approved ? 'timesheet.approved' : 'timesheet.rejected', { timesheet_id: d.timesheet_id, period_start: d.period_start }));
    case 'time_off.requested':
      return void (await send('time_off.requested', { request_id: d.request_id, start_date: d.start_date, end_date: d.end_date }));
    case 'time_off.decided':
      return void (await send(d.approved ? 'time_off.approved' : 'time_off.rejected', { request_id: d.request_id, start_date: d.start_date, end_date: d.end_date }));
    case 'user.invited':
      return void (await send('user.invited', {}));
    case 'user.deactivated':
      return void (await send('user.deactivated', {}));
    case 'device.revoked':
      return void (await send('device.revoked', { device_id: d.device_id }));
    default:
      return;
  }
}

// ───────────── who hears about it ─────────────

/** Active org admins. */
export async function orgAdmins(q: Queryable, orgId: string): Promise<string[]> {
  const rows = await many<{ id: string }>(
    q,
    `SELECT id FROM users WHERE organization_id = $1 AND status = 'active' AND org_role IN ('org_admin', 'super_admin')`,
    [orgId],
  );
  return rows.map((r) => r.id);
}

/**
 * Who reviews this person's requests: the managers of their teams, or the org admins when
 * they have none, so nothing waits on nobody. Never the person themselves.
 */
export async function reviewersOf(q: Queryable, orgId: string, userId: string): Promise<string[]> {
  const managers = await many<{ id: string }>(
    q,
    `SELECT DISTINCT m.user_id AS id FROM team_memberships m
     JOIN team_memberships t ON t.team_id = m.team_id AND t.user_id = $2 AND t.valid_to IS NULL
     JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.organization_id = $1 AND m.role = 'manager' AND m.valid_to IS NULL AND m.user_id <> $2`,
    [orgId, userId],
  );
  const ids = managers.length ? managers.map((r) => r.id) : await orgAdmins(q, orgId);
  return ids.filter((id) => id !== userId);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** A date from the event, written for the reader. */
const day = (l: Lang, iso: unknown) => (typeof iso === 'string' ? l.day(iso) : '');
/** An amount from the event: formatted for the reader when the event carries cents, else as published. */
const amountOf = (l: Lang, d: Record<string, unknown>) =>
  typeof d.amount_cents === 'number' && typeof d.currency === 'string' ? l.money(d.amount_cents, d.currency) : str(d.amount);
/** A week from the event ("19 Oct"), else its published label. */
const weekOf = (l: Lang, d: Record<string, unknown>) => (typeof d.week === 'string' ? l.dayMonth(d.week) : str(d.week_label));
/** When something is due, in the person's own time zone when the event says which. */
const dueOf = (l: Lang, d: Record<string, unknown>) =>
  typeof d.due_at === 'string' && typeof d.tz === 'string' ? l.dueTime(Date.parse(d.due_at), d.tz) : str(d.due_label);
const PERMISSIONS = ['input_monitoring', 'screen_recording'] as const;
const permissionOf = (d: Record<string, unknown>) => PERMISSIONS.find((p) => p === d.permission);

async function notifyFor(q: Queryable, e: DomainEvent): Promise<void> {
  const d = e.data;
  const send = (to: string[], n: Omit<NotificationInput, 'eventId'>) => notify(q, e.organizationId, to, { ...n, eventId: e.id });
  const subject = e.subjectUserId ? [e.subjectUserId] : [];
  switch (e.type) {
    case 'correction.submitted':
      await send(await reviewersOf(q, e.organizationId, e.subjectUserId!), {
        kind: 'correction_review',
        category: 'approvals',
        title: (l) => l.t('ev.correctionSubmitted.title', { name: str(d.user_name) }),
        body: (l) => l.t('ev.reviewInApprovals'),
        link: '/approvals',
      });
      return;
    case 'correction.decided':
      await send(subject, {
        kind: 'correction_decision',
        category: 'my_requests',
        title: (l) => (d.approved ? l.t('ev.correctionApproved.title') : l.t('ev.correctionSentBack.title')),
        body: (l) =>
          d.approved
            ? l.t('ev.correctionApproved.body', { name: str(d.reviewer_name) })
            : d.note
              ? l.t('ev.correctionSentBack.bodyNote', { name: str(d.reviewer_name), note: str(d.note) })
              : l.t('ev.correctionSentBack.body', { name: str(d.reviewer_name) }),
        link: '/me/time',
      });
      return;
    case 'timesheet.submitted':
      await send(await reviewersOf(q, e.organizationId, e.subjectUserId!), {
        kind: 'timesheet_submitted',
        category: 'approvals',
        title: (l) => l.t('ev.timesheetSubmitted.title', { name: str(d.user_name) }),
        body: (l) => l.t('ev.timesheetSubmitted.body', { week: day(l, d.period_start) }),
        link: '/approvals',
      });
      return;
    case 'deletion_request.decided':
      // An approval is followed by deletion_request.completed once the file is gone.
      if (d.approved) return;
      await send(subject, {
        kind: 'deletion_declined',
        category: 'privacy',
        title: (l) => l.t('ev.deletionDeclined.title'),
        body: (l) => l.t('ev.deletionDeclined.body', { name: str(d.reviewer_name) }),
        link: '/me/privacy',
      });
      return;
    case 'deletion_request.completed':
      await send(subject, {
        kind: 'deletion_completed',
        category: 'privacy',
        title: (l) => l.t('ev.deletionDone.title'),
        body: (l) => l.t('ev.deletionDone.body'),
        link: '/me/privacy',
      });
      return;
    case 'device.revoked':
      await send(subject, {
        kind: 'device_revoked',
        category: 'devices',
        title: (l) => l.t('ev.deviceRevoked.title', { device: str(d.device_name) }),
        body: (l) => l.t('ev.deviceRevoked.body'),
        link: '/me',
      });
      return;
    case 'device.permission_missing': {
      const perm = permissionOf(d);
      await send(subject, {
        kind: 'device_permission',
        category: 'devices',
        title: (l) => l.t('ev.permission.title', { device: str(d.device_name) }),
        body: (l) =>
          l.t('ev.permission.body', {
            what: perm ? l.t(`perm.what.${perm}`) : str(d.what),
            permission: perm ? l.t(`perm.${perm}`) : str(d.permission_label),
          }),
        link: '/me',
      });
      return;
    }
    case 'support_grant.requested': {
      const hours = Number(d.hours);
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'support_request',
        category: 'security',
        title: (l) => l.t('ev.supportRequest.title'),
        body: (l) => l.t(hours === 1 ? 'ev.supportRequest.body.one' : 'ev.supportRequest.body.other', { operator: str(d.operator_name), n: hours, reason: str(d.reason) }),
        link: '/admin/support',
      });
      return;
    }
    case 'billing.trial_ending': {
      const days = Number(d.days_left);
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'trial_ending',
        category: 'billing',
        title: (l) => l.t(days === 1 ? 'ev.trialEnding.title.one' : 'ev.trialEnding.title.other', { n: days }),
        body: (l) => l.t('ev.trialEnding.body', { date: day(l, d.ends_at) }),
        link: '/admin/billing',
      });
      return;
    }
    case 'billing.payment_failed':
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'payment_failed',
        category: 'billing',
        title: (l) => l.t('ev.paymentFailed.title'),
        body: (l) => l.t('ev.paymentFailed.body', { date: day(l, d.grace_ends_at) }),
        link: '/admin/billing',
      });
      return;
    case 'billing.grace_ending':
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'grace_ending',
        category: 'billing',
        title: (l) => l.t('ev.graceEnding.title'),
        body: (l) => l.t('ev.graceEnding.body', { date: day(l, d.grace_ends_at) }),
        link: '/admin/billing',
      });
      return;
    case 'billing.inactive':
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'subscription_inactive',
        category: 'billing',
        title: (l) => l.t('ev.inactive.title'),
        body: (l) => l.t('ev.inactive.body'),
        link: '/admin/billing',
      });
      return;
    case 'timesheet.due_soon':
      await send(subject, {
        kind: 'timesheet_due',
        category: 'my_requests',
        title: (l) => l.t('ev.timesheetDue.title', { week: weekOf(l, d), due: dueOf(l, d) }),
        body: (l) => l.t('ev.timesheetDue.body'),
        link: '/me/time',
      });
      return;
    case 'timesheet.overdue':
      await send(subject, {
        kind: 'timesheet_overdue',
        category: 'my_requests',
        title: (l) => l.t('ev.timesheetOverdue.title', { week: weekOf(l, d) }),
        body: (l) => l.t('ev.timesheetOverdue.body', { due: dueOf(l, d) }),
        link: '/me/time',
      });
      return;
    case 'timesheet.escalated': {
      const names = Array.isArray(d.names) ? (d.names as string[]) : [];
      const count = Number(d.count);
      await send(subject, {
        kind: 'timesheet_escalated',
        category: 'approvals',
        title: (l) => l.t(count === 1 ? 'ev.escalated.title.one' : 'ev.escalated.title.other', { n: count, week: weekOf(l, d) }),
        body: (l) =>
          l.t('ev.escalated.body', {
            names: count > names.length ? l.t('ev.escalated.more', { names: names.join(', '), n: count - names.length }) : names.join(', '),
          }),
        link: str(d.link) || '/team',
      });
      return;
    }
    case 'device.stale':
      await send(subject, {
        kind: 'device_stale',
        category: 'devices',
        title: (l) => l.t('ev.deviceStale.title', { device: str(d.device_name) }),
        body: (l) => l.t('ev.deviceStale.body', { date: day(l, d.last_seen_at) }),
        link: '/me',
      });
      return;
    // Notified by their own modules (timesheet and time-off decisions, time-off requests);
    // published for integrations and history.
    case 'timesheet.decided':
    case 'time_off.requested':
    case 'expense.submitted':
      await send(await reviewersOf(q, e.organizationId, e.subjectUserId!), {
        kind: 'expense_review',
        category: 'approvals',
        title: (l) => l.t('ev.expenseClaimed.title', { name: str(d.user_name), amount: amountOf(l, d) }),
        body: str(d.note),
        link: '/approvals',
      });
      return;
    case 'expense.decided':
      await send(subject, {
        kind: d.approved ? 'expense_approved' : 'expense_sent_back',
        category: 'my_requests',
        title: (l) =>
          d.approved
            ? l.t('ev.expenseApproved.title', { amount: amountOf(l, d) })
            : l.t('ev.expenseSentBack.title', { name: str(d.reviewer_name), amount: amountOf(l, d) }),
        body: (l) => (d.approved ? l.t('ev.expenseApproved.body') : str(d.review_note) || l.t('ev.expenseSentBack.body')),
        link: '/me/expenses',
      });
      return;
    case 'time_off.decided':
    case 'user.invited':
    case 'user.deactivated':
      return;
  }
}
