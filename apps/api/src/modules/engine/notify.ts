import {
  MANDATORY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFAULTS,
  type NotificationCategory,
  type NotificationDTO,
  type NotificationPreference,
  type NotificationsResponse,
} from '@rd/contracts';
import type { Deps } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { notificationEmail } from '../../email/templates';
import { lang, localesOf, render, SERVER_DEFAULT_LOCALE, type Localized } from '../../i18n';
import { enqueue } from '../../jobs/queue';

/**
 * The one way anything tells a person something (docs/design/07-product-review.md §3).
 * In-app is written now, in the caller's transaction; email is a queued job, so a slow
 * or failing mail provider never blocks or loses the in-app notice.
 */

export interface NotificationInput {
  kind: string;
  category: NotificationCategory;
  /** Written for each person in their language (G27); a plain string is the same for everyone. */
  title: Localized;
  body: Localized;
  /** In-app path to act on it. */
  link?: string | null;
  /** The domain event behind it: one notification per person per event. */
  eventId?: string | null;
}

type Pref = { in_app: boolean; email: boolean };

function effective(category: NotificationCategory, row: Pref | undefined): Pref {
  if (MANDATORY_CATEGORIES.includes(category)) return { in_app: true, email: true };
  return row ?? NOTIFICATION_DEFAULTS[category];
}

/** Notifies active people of the organization; returns how many were notified. */
export async function notify(q: Queryable, orgId: string, userIds: Iterable<string>, n: NotificationInput): Promise<number> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return 0;
  const people = await many<{ id: string; in_app: boolean | null; email: boolean | null }>(
    q,
    `SELECT u.id, p.in_app, p.email FROM users u
     LEFT JOIN notification_preferences p ON p.user_id = u.id AND p.category = $3
     WHERE u.organization_id = $1 AND u.id = ANY($2::uuid[]) AND u.status = 'active'`,
    [orgId, ids, n.category],
  );
  const locales = await localesOf(q, people.map((p) => p.id));
  let sent = 0;
  for (const p of people) {
    const pref = effective(n.category, p.in_app === null ? undefined : { in_app: p.in_app, email: p.email! });
    if (!pref.in_app && !pref.email) continue;
    const l = lang(locales.get(p.id) ?? SERVER_DEFAULT_LOCALE);
    const row = await one<{ id: string }>(
      q,
      `INSERT INTO notifications (organization_id, user_id, kind, category, title, body, link, event_id, in_app)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id, user_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING id`,
      [orgId, p.id, n.kind, n.category, render(n.title, l), render(n.body, l), n.link ?? null, n.eventId ?? null, pref.in_app],
    );
    if (!row) continue;
    if (pref.email) await enqueue(q, 'notification.email', { notification_id: row.id }, { organizationId: orgId, maxAttempts: 6 });
    sent++;
  }
  return sent;
}

/** Worker: sends one notification's email once. Throws to let the queue retry. */
export async function sendNotificationEmail(deps: Deps, q: Queryable, notificationId: string): Promise<void> {
  const n = await one<{ title: string; body: string; link: string | null; category: NotificationCategory; email: string; org_name: string; user_id: string }>(
    q,
    `SELECT n.title, n.body, n.link, n.category, u.email, o.name AS org_name, u.id AS user_id
     FROM notifications n JOIN users u ON u.id = n.user_id JOIN organizations o ON o.id = n.organization_id
     WHERE n.id = $1 AND n.emailed_at IS NULL AND u.status = 'active'`,
    [notificationId],
  );
  if (!n) return;
  const l = lang((await localesOf(q, [n.user_id])).get(n.user_id) ?? SERVER_DEFAULT_LOCALE);
  await deps.email.send(notificationEmail({ to: n.email, orgName: n.org_name, title: n.title, body: n.body, link: n.link, category: n.category, webUrl: deps.config.webUrl, l }));
  await q.query('UPDATE notifications SET emailed_at = now() WHERE id = $1', [notificationId]);
}

// ───────────── reads and preferences (the signed-in person only) ─────────────

const SELECT = `SELECT id, kind, category, title, body, link, created_at, read_at FROM notifications`;

export async function listNotifications(q: Queryable, userId: string, opts: { unreadOnly?: boolean } = {}): Promise<NotificationsResponse> {
  const items = await many<NotificationDTO>(
    q,
    `${SELECT} WHERE user_id = $1 AND in_app AND ($2::boolean IS FALSE OR read_at IS NULL) ORDER BY created_at DESC LIMIT 100`,
    [userId, opts.unreadOnly ?? false],
  );
  return { items, unread: await unreadCount(q, userId) };
}

export async function unreadCount(q: Queryable, userId: string): Promise<number> {
  const r = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND in_app AND read_at IS NULL', [userId]);
  return r?.n ?? 0;
}

export async function markRead(q: Queryable, userId: string, id: string): Promise<void> {
  await q.query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2', [id, userId]);
}

export async function markAllRead(q: Queryable, userId: string): Promise<number> {
  const r = await q.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return r.rowCount ?? 0;
}

export async function preferencesFor(q: Queryable, userId: string): Promise<NotificationPreference[]> {
  const rows = await many<{ category: NotificationCategory; in_app: boolean; email: boolean }>(
    q,
    'SELECT category, in_app, email FROM notification_preferences WHERE user_id = $1',
    [userId],
  );
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    ...effective(category, rows.find((r) => r.category === category)),
    mandatory: MANDATORY_CATEGORIES.includes(category),
  }));
}

export async function updatePreferences(
  q: Queryable,
  orgId: string,
  userId: string,
  items: { category: NotificationCategory; in_app: boolean; email: boolean }[],
): Promise<NotificationPreference[]> {
  for (const i of items) {
    if (MANDATORY_CATEGORIES.includes(i.category)) continue; // can't be turned off; nothing to store
    await q.query(
      `INSERT INTO notification_preferences (organization_id, user_id, category, in_app, email) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, category) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email, updated_at = now()`,
      [orgId, userId, i.category, i.in_app, i.email],
    );
  }
  return preferencesFor(q, userId);
}
