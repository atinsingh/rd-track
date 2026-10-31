import type { NotificationDTO } from '@rd/contracts';
import { t } from './i18n';
import { dateInTz, formatDayMonth } from './time';

/** "just now", "12 min ago", "3 h ago", "yesterday", or the date. */
export function ago(iso: string, nowMs: number, tz: string): string {
  const s = Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  if (s < 60) return t('time.justNow');
  if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 24 * 3600) return t('time.hoursAgo', { n: Math.floor(s / 3600) });
  if (s < 48 * 3600) return t('time.yesterday');
  return formatDayMonth(dateInTz(Date.parse(iso), tz));
}

/** Unread first ("New"), then the rest ("Earlier"), each newest first; empty groups dropped. */
export function groupNotifications(items: NotificationDTO[]): { label: string; items: NotificationDTO[] }[] {
  const newest = (a: NotificationDTO, b: NotificationDTO) => Date.parse(b.created_at) - Date.parse(a.created_at);
  return [
    { label: t('notifications.new'), items: items.filter((n) => !n.read_at).sort(newest) },
    { label: t('notifications.earlier'), items: items.filter((n) => n.read_at).sort(newest) },
  ].filter((g) => g.items.length > 0);
}

/** The bell's label for screen readers and the badge text ("9+" past nine). */
export function bellLabel(unread: number): { label: string; badge: string | null } {
  if (unread <= 0) return { label: t('notifications.title'), badge: null };
  return { label: t('notifications.unreadLabel', { n: unread }), badge: unread > 9 ? '9+' : String(unread) };
}
