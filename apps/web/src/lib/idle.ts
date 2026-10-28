import type { SessionDTO } from '@rd/contracts';
import { formatTime } from './time';

/**
 * What the person chose for idle runs in this session (Stage 4 F1), in words that
 * read the same on their own page and on their manager's view of it.
 */
export function idleNotes(x: SessionDTO, tz: string): string[] {
  return (x.idle_adjustments ?? []).map((a) => {
    const span = `${Math.max(1, Math.round(a.seconds / 60))} min away (${formatTime(a.idle_started_at, tz)}–${formatTime(a.idle_ended_at, tz)})`;
    const target = a.project_name ?? 'another project';
    if (a.decision === 'discard') {
      return a.status === 'rejected' ? `${span} — couldn't be removed: ${rejectReason(a.status_reason)}` : `${span} removed on return`;
    }
    if (a.status === 'pending') return `${span} → ${target} · waiting for approval`;
    if (a.status === 'applied') return `${span} moved to ${target}`;
    return `${span} — move to ${target} ${a.status_reason ? `failed: ${rejectReason(a.status_reason)}` : 'not approved, kept here'}`;
  });
}

function rejectReason(code: string | null): string {
  switch (code) {
    case 'week_locked':
      return 'that week is approved and locked';
    case 'unknown_project':
      return 'the project is no longer active';
    default:
      return 'not applied';
  }
}
