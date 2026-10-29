import type { DomainEventType, WebhookEventType } from '@rd/contracts';
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
const day = (iso: unknown) =>
  typeof iso === 'string' ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso)) : '';

async function notifyFor(q: Queryable, e: DomainEvent): Promise<void> {
  const d = e.data;
  const send = (to: string[], n: Omit<NotificationInput, 'eventId'>) => notify(q, e.organizationId, to, { ...n, eventId: e.id });
  const subject = e.subjectUserId ? [e.subjectUserId] : [];
  switch (e.type) {
    case 'correction.submitted':
      await send(await reviewersOf(q, e.organizationId, e.subjectUserId!), {
        kind: 'correction_review',
        category: 'approvals',
        title: `${str(d.user_name)} asked to correct their time`,
        body: 'Review it in Approvals.',
        link: '/approvals',
      });
      return;
    case 'correction.decided':
      await send(subject, {
        kind: 'correction_decision',
        category: 'my_requests',
        title: d.approved ? 'Your time correction was approved' : 'Your time correction was sent back',
        body: d.approved
          ? `${str(d.reviewer_name)} approved it.`
          : `${str(d.reviewer_name)} sent it back${d.note ? `: “${str(d.note)}”` : '.'}`,
        link: '/me/time',
      });
      return;
    case 'timesheet.submitted':
      await send(await reviewersOf(q, e.organizationId, e.subjectUserId!), {
        kind: 'timesheet_submitted',
        category: 'approvals',
        title: `${str(d.user_name)} submitted their timesheet`,
        body: `Week of ${day(d.period_start)}. Review it in Approvals.`,
        link: '/approvals',
      });
      return;
    case 'deletion_request.decided':
      // An approval is followed by deletion_request.completed once the file is gone.
      if (d.approved) return;
      await send(subject, {
        kind: 'deletion_declined',
        category: 'privacy',
        title: 'Your screenshot deletion request was declined',
        body: `${str(d.reviewer_name)} declined it. The screenshot keeps its normal retention date.`,
        link: '/me/privacy',
      });
      return;
    case 'deletion_request.completed':
      await send(subject, {
        kind: 'deletion_completed',
        category: 'privacy',
        title: 'Your screenshot was deleted',
        body: 'The image and its preview are gone from storage. The deletion is in your access log.',
        link: '/me/privacy',
      });
      return;
    case 'device.revoked':
      await send(subject, {
        kind: 'device_revoked',
        category: 'devices',
        title: `${str(d.device_name)} was disconnected from Track`,
        body: 'Your org admin disconnected this computer. It no longer tracks or sends anything.',
        link: '/me',
      });
      return;
    case 'device.permission_missing':
      await send(subject, {
        kind: 'device_permission',
        category: 'devices',
        title: `${str(d.device_name)} needs a permission`,
        body: `Track can't measure ${str(d.what)} until you allow “${str(d.permission_label)}” in system settings. Nothing else is collected.`,
        link: '/me',
      });
      return;
    case 'support_grant.requested': {
      const hours = Number(d.hours);
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'support_request',
        category: 'security',
        title: 'RoundDigital support asks to look at your setup',
        body: `${str(d.operator_name)} asked for ${hours} ${hours === 1 ? 'hour' : 'hours'} of read-only access to your configuration (people, teams, devices, policies, audit log; never activity or screenshots): “${str(d.reason)}”. Approve or decline in Support access.`,
        link: '/admin/support',
      });
      return;
    }
    case 'billing.trial_ending': {
      const days = Number(d.days_left);
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'trial_ending',
        category: 'billing',
        title: `Your Pro trial ends in ${days} ${days === 1 ? 'day' : 'days'}`,
        body: `Choose a plan before ${day(d.ends_at)} to keep everything you've set up. Up to 2 people can stay on Free.`,
        link: '/admin/billing',
      });
      return;
    }
    case 'billing.payment_failed':
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'payment_failed',
        category: 'billing',
        title: 'A payment failed — update your payment method',
        body: `Everything keeps working until ${day(d.grace_ends_at)}. After that, agents stop tracking and tell people why.`,
        link: '/admin/billing',
      });
      return;
    case 'billing.grace_ending':
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'grace_ending',
        category: 'billing',
        title: 'Tracking stops in 3 days',
        body: `The grace period ends on ${day(d.grace_ends_at)}. Choose a plan or update payment to keep tracking.`,
        link: '/admin/billing',
      });
      return;
    case 'billing.inactive':
      await send(await orgAdmins(q, e.organizationId), {
        kind: 'subscription_inactive',
        category: 'billing',
        title: 'Your subscription is inactive — nothing is being collected',
        body: 'Agents stopped tracking and show a notice. Reports and exports stay readable. Choose a plan to resume.',
        link: '/admin/billing',
      });
      return;
    case 'timesheet.due_soon':
      await send(subject, {
        kind: 'timesheet_due',
        category: 'my_requests',
        title: `Your timesheet for the week of ${str(d.week_label)} is due ${str(d.due_label)}`,
        body: 'Check the week and submit it for approval.',
        link: '/me/time',
      });
      return;
    case 'timesheet.overdue':
      await send(subject, {
        kind: 'timesheet_overdue',
        category: 'my_requests',
        title: `Your timesheet for the week of ${str(d.week_label)} is overdue`,
        body: `It was due ${str(d.due_label)}. Submit it so your reviewer can approve it.`,
        link: '/me/time',
      });
      return;
    case 'timesheet.escalated': {
      const names = Array.isArray(d.names) ? (d.names as string[]) : [];
      const count = Number(d.count);
      await send(subject, {
        kind: 'timesheet_escalated',
        category: 'approvals',
        title: `${count} ${count === 1 ? 'timesheet is' : 'timesheets are'} overdue for the week of ${str(d.week_label)}`,
        body: `${names.join(', ')}${count > names.length ? ` and ${count - names.length} more` : ''} haven't submitted yet.`,
        link: str(d.link) || '/team',
      });
      return;
    }
    case 'device.stale':
      await send(subject, {
        kind: 'device_stale',
        category: 'devices',
        title: `${str(d.device_name)} hasn’t synced for a few working days`,
        body: `Last seen ${day(d.last_seen_at)}. If you've been working on it, open Track so your time arrives. If you no longer use it, ask your org admin to remove it.`,
        link: '/me',
      });
      return;
    // Notified by their own modules (timesheet and time-off decisions, time-off requests);
    // published for integrations and history.
    case 'timesheet.decided':
    case 'time_off.requested':
    case 'time_off.decided':
    case 'user.invited':
    case 'user.deactivated':
      return;
  }
}
