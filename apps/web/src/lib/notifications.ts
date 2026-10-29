import type { NotificationDTO } from '@rd/contracts';

/** "just now", "12 min ago", "3 h ago", "yesterday", or the date. */
export function ago(iso: string, nowMs: number, tz: string): string {
  const s = Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 24 * 3600) return `${Math.floor(s / 3600)} h ago`;
  if (s < 48 * 3600) return 'yesterday';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso));
}

/** Unread first ("New"), then the rest ("Earlier"), each newest first; empty groups dropped. */
export function groupNotifications(items: NotificationDTO[]): { label: string; items: NotificationDTO[] }[] {
  const newest = (a: NotificationDTO, b: NotificationDTO) => Date.parse(b.created_at) - Date.parse(a.created_at);
  return [
    { label: 'New', items: items.filter((n) => !n.read_at).sort(newest) },
    { label: 'Earlier', items: items.filter((n) => n.read_at).sort(newest) },
  ].filter((g) => g.items.length > 0);
}

/** The bell's label for screen readers and the badge text ("9+" past nine). */
export function bellLabel(unread: number): { label: string; badge: string | null } {
  if (unread <= 0) return { label: 'Notifications', badge: null };
  return { label: `Notifications, ${unread} unread`, badge: unread > 9 ? '9+' : String(unread) };
}
