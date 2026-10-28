import type { ReactNode } from 'react';
import type { SessionDTO } from '@rd/contracts';
import { Card } from '@/components/ui/Layout';
import { Empty } from '@/components/ui/DataState';
import { formatDuration } from '@/lib/format';
import { formatTime } from '@/lib/time';
import s from './day.module.css';

export function sessionTitle(x: SessionDTO): string {
  const project = x.project_name ?? 'No project';
  return x.task_name ? `${project} · ${x.task_name}` : project;
}

export function sessionNote(x: SessionDTO): string {
  const parts: string[] = [x.source === 'manual' ? 'Manual' : 'Agent'];
  if (x.corrected) parts.push('corrected');
  if (x.state === 'paused') parts.push('paused now');
  if (x.paused_seconds >= 60) parts.push(`paused ${Math.round(x.paused_seconds / 60)} min`);
  return parts.join(' · ');
}

export function SessionsList({ sessions, tz, action }: { sessions: readonly SessionDTO[]; tz: string; action?: ReactNode }) {
  const sorted = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at));
  return (
    <Card title="Sessions" actions={action} className="grow">
      {sorted.length === 0 ? (
        <Empty title="No sessions">Sessions start only when you press Start in the desktop agent.</Empty>
      ) : (
        <ul className={s.sessions}>
          {sorted.map((x) => (
            <li key={x.id} className={s.sessionRow}>
              <span className={s.sessionTime}>
                {formatTime(x.started_at, tz)}–{x.ended_at ? formatTime(x.ended_at, tz) : 'now'}
              </span>
              <span className={s.sessionWhat}>
                <span className={s.sessionTitle}>{sessionTitle(x)}</span>
                <span className={s.sessionNote}>{sessionNote(x)}</span>
              </span>
              <span className={s.sessionDur}>{formatDuration(x.tracked_seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
