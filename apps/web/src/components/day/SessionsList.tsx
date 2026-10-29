import type { ReactNode } from 'react';
import type { SessionDTO } from '@rd/contracts';
import { Card } from '@/components/ui/Layout';
import { Empty } from '@/components/ui/DataState';
import { formatDuration } from '@/lib/format';
import { idleNotes } from '@/lib/idle';
import { formatTime } from '@/lib/time';
import { t } from '@/lib/i18n';
import s from './day.module.css';

export function sessionTitle(x: SessionDTO): string {
  const project = x.project_name ?? t('session.noProject');
  return x.task_name ? `${project} · ${x.task_name}` : project;
}

export function sessionNote(x: SessionDTO): string {
  const parts: string[] = [x.source === 'manual' ? t('session.manual') : t('session.agent')];
  if (x.corrected) parts.push(t('session.corrected'));
  if (x.state === 'paused') parts.push(t('session.pausedNow'));
  if (x.paused_seconds >= 60) parts.push(t('session.pausedFor', { n: Math.round(x.paused_seconds / 60) }));
  return parts.join(' · ');
}

export function SessionsList({ sessions, tz, action }: { sessions: readonly SessionDTO[]; tz: string; action?: ReactNode }) {
  const sorted = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at));
  return (
    <Card title={t('session.list')} actions={action} className="grow">
      {sorted.length === 0 ? (
        <Empty title={t('session.none')}>{t('session.noneBody')}</Empty>
      ) : (
        <ul className={s.sessions}>
          {sorted.map((x) => (
            <li key={x.id} className={s.sessionRow}>
              <span className={s.sessionTime}>
                {formatTime(x.started_at, tz)}–{x.ended_at ? formatTime(x.ended_at, tz) : t('session.now')}
              </span>
              <span className={s.sessionWhat}>
                <span className={s.sessionTitle}>{sessionTitle(x)}</span>
                <span className={s.sessionNote}>{sessionNote(x)}</span>
                {idleNotes(x, tz).map((n) => (
                  <span key={n} className={s.sessionNote}>
                    {n}
                  </span>
                ))}
              </span>
              <span className={s.sessionDur}>{formatDuration(x.tracked_seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
