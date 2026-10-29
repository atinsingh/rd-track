import type { ActivityTotals, SessionDTO } from '@rd/contracts';
import { activityPercent } from '@rd/contracts';
import { ActivityInfo } from '@/components/ui/ActivityInfo';
import { formatDuration, formatPercent } from '@/lib/format';
import { t } from '@/lib/i18n';
import s from './day.module.css';

export function SummaryTiles({
  totals,
  sessions,
  activityVisible,
}: {
  totals: ActivityTotals | null;
  sessions: readonly SessionDTO[];
  activityVisible: boolean;
}) {
  const agentSessions = sessions.filter((x) => x.source === 'agent');
  const manualSessions = sessions.filter((x) => x.source === 'manual');
  const projects = [...new Set(agentSessions.map((x) => x.project_name ?? t('session.noProject')))];
  const tracked = totals?.tracked_seconds ?? agentSessions.reduce((a, x) => a + x.tracked_seconds, 0);
  const manual = totals?.manual_seconds ?? manualSessions.reduce((a, x) => a + x.tracked_seconds, 0);
  const pct = totals ? (totals.activity_percent ?? activityPercent(totals.active_seconds, totals.idle_seconds)) : null;
  const paused = totals?.paused_seconds ?? 0;
  const gaps = totals?.gap_seconds ?? 0;

  return (
    <section aria-label={t('tiles.label')} className={s.tiles}>
      <div className={s.tile}>
        <span className={s.tileLabel}>{t('tiles.tracked')}</span>
        <span className={s.tileValue}>{formatDuration(tracked)}</span>
        <span className={s.tileSub}>
          {t(agentSessions.length === 1 ? 'tiles.sessions.one' : 'tiles.sessions.other', { n: agentSessions.length })}
          {projects.length ? ` · ${projects.slice(0, 2).join(', ')}${projects.length > 2 ? '…' : ''}` : ''}
        </span>
      </div>
      <div className={s.tile}>
        <span className={s.tileLabel}>
          {t('tiles.activity')}
          <ActivityInfo />
        </span>
        <span className={s.tileValue}>{!activityVisible ? '—' : pct === null ? '—' : formatPercent(pct)}</span>
        <span className={s.tileSub}>
          {!activityVisible ? t('tiles.notShared') : pct === null ? t('tiles.noMeasurable') : t('tiles.hadInput')}
        </span>
      </div>
      <div className={s.tile}>
        <span className={s.tileLabel}>{t('tiles.manual')}</span>
        <span className={s.tileValue}>{formatDuration(manual)}</span>
        <span className={s.tileSub}>{manualSessions.length ? t(manualSessions.length === 1 ? 'tiles.entries.one' : 'tiles.entries.other', { n: manualSessions.length }) : t('tiles.noManual')}</span>
      </div>
      <div className={s.tile}>
        <span className={s.tileLabel}>{t('tiles.notMeasured')}</span>
        <span className={s.tileValue}>{formatDuration(paused + gaps)}</span>
        <span className={s.tileSub}>
          {t('tiles.notMeasuredDetail', { paused: formatDuration(paused), gaps: formatDuration(gaps) })}
        </span>
      </div>
    </section>
  );
}
