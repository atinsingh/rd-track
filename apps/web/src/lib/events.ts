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
