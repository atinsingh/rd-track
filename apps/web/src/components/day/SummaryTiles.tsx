import type { ActivityTotals, SessionDTO } from '@rd/contracts';
import { activityPercent } from '@rd/contracts';
import { ActivityInfo } from '@/components/ui/ActivityInfo';
import { formatDuration, plural } from '@/lib/format';
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
  const projects = [...new Set(agentSessions.map((x) => x.project_name ?? 'No project'))];
  const tracked = totals?.tracked_seconds ?? agentSessions.reduce((a, x) => a + x.tracked_seconds, 0);
  const manual = totals?.manual_seconds ?? manualSessions.reduce((a, x) => a + x.tracked_seconds, 0);
  const pct = totals ? (totals.activity_percent ?? activityPercent(totals.active_seconds, totals.idle_seconds)) : null;
  const paused = totals?.paused_seconds ?? 0;
  const gaps = totals?.gap_seconds ?? 0;

  return (
    <section aria-label="Day summary" className={s.tiles}>
      <div className={s.tile}>
        <span className={s.tileLabel}>Tracked by agent</span>
        <span className={s.tileValue}>{formatDuration(tracked)}</span>
        <span className={s.tileSub}>
          {plural(agentSessions.length, 'session')}
          {projects.length ? ` · ${projects.slice(0, 2).join(', ')}${projects.length > 2 ? '…' : ''}` : ''}
        </span>
      </div>
      <div className={s.tile}>
        <span className={s.tileLabel}>
          Computer activity
          <ActivityInfo />
        </span>
        <span className={s.tileValue}>{!activityVisible ? '—' : pct === null ? '—' : `${pct}%`}</span>
        <span className={s.tileSub}>
          {!activityVisible
            ? 'Not shared with you under policy'
            : pct === null
              ? 'No measurable time'
              : 'of measurable time had input'}
        </span>
      </div>
      <div className={s.tile}>
        <span className={s.tileLabel}>Manual time</span>
        <span className={s.tileValue}>{formatDuration(manual)}</span>
        <span className={s.tileSub}>{manualSessions.length ? plural(manualSessions.length, 'entry', 'entries') : 'No manual entries'}</span>
      </div>
      <div className={s.tile}>
        <span className={s.tileLabel}>Not measured</span>
        <span className={s.tileValue}>{formatDuration(paused + gaps)}</span>
        <span className={s.tileSub}>
          paused {formatDuration(paused)} · asleep, offline or no permission {formatDuration(gaps)} — not idle
        </span>
      </div>
    </section>
  );
}
