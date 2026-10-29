/**
 * Tiny in-page signal: something was approved, rejected or submitted, so anything
 * showing a pending count (the nav badge) should refresh.
 */
export const APPROVALS_CHANGED = 'rd:approvals-changed';

export function announceApprovalsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPROVALS_CHANGED));
}

export function onApprovalsChanged(fn: () => void): () => void {
  window.addEventListener(APPROVALS_CHANGED, fn);
  return () => window.removeEventListener(APPROVALS_CHANGED, fn);
}

export const NOTIFICATIONS_CHANGED = 'rd:notifications-changed';

/** Something was read or may have produced a notification: the bell refreshes its count. */
export function announceNotificationsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

export function onNotificationsChanged(fn: () => void): () => void {
  window.addEventListener(NOTIFICATIONS_CHANGED, fn);
  return () => window.removeEventListener(NOTIFICATIONS_CHANGED, fn);
}
