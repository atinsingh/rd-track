import type { SessionDTO } from '@rd/contracts';
import { formatTime } from './time';
import { t } from './i18n';

/**
 * What the person chose for idle runs in this session (Stage 4 F1), in words that
 * read the same on their own page and on their manager's view of it.
 */
export function idleNotes(x: SessionDTO, tz: string): string[] {
  return (x.idle_adjustments ?? []).map((a) => {
    const span = t('idle.away', { n: Math.max(1, Math.round(a.seconds / 60)), from: formatTime(a.idle_started_at, tz), to: formatTime(a.idle_ended_at, tz) });
    const target = a.project_name ?? t('idle.anotherProject');
    if (a.decision === 'discard') {
      return a.status === 'rejected' ? t('idle.notRemoved', { span, reason: rejectReason(a.status_reason) }) : t('idle.removed', { span });
    }
    if (a.status === 'pending') return t('idle.waiting', { span, target });
    if (a.status === 'applied') return t('idle.moved', { span, target });
    return a.status_reason ? t('idle.moveFailed', { span, target, reason: rejectReason(a.status_reason) }) : t('idle.moveRejected', { span, target });
  });
}

function rejectReason(code: string | null): string {
  switch (code) {
    case 'week_locked':
      return t('idle.weekLocked');
    case 'unknown_project':
      return t('idle.unknownProject');
    default:
      return t('idle.notApplied');
  }
}
