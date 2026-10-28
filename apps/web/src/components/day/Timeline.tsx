'use client';

import { useId, useMemo, useState } from 'react';
import type { ActivityResponse, SessionDTO } from '@rd/contracts';
import { activityPercent } from '@rd/contracts';
import { Card, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { ActivityInfo } from '@/components/ui/ActivityInfo';
import { cx } from '@/lib/cx';
import { formatDuration } from '@/lib/format';
import { formatTime } from '@/lib/time';
import {
  KIND_LABEL,
  buildTimelineColumns,
  describeTimeline,
  timelineRuns,
  timelineWindow,
  type ColumnKind,
  type TimelineColumn,
} from '@/lib/timeline';
import s from './day.module.css';

const KIND_CLASS: Record<ColumnKind, string | undefined> = {
  activity: s.kindActivity,
  paused: s.kindPaused,
  offline: s.kindOffline,
  permission: s.kindPermission,
  none: s.kindNone,
};

const QUALITY_TEXT = { ok: 'data ok', partial: 'partial data', permission_missing: 'no permission to measure' } as const;

function columnTitle(c: TimelineColumn, tz: string): string {
  const span = `${formatTime(c.start, tz)}–${formatTime(c.end, tz)}`;
  if (c.kind === 'activity') {
    const q = c.quality ? ` · ${QUALITY_TEXT[c.quality]}` : '';
    return `${span} · active ${Math.round(c.activeSeconds)} s, idle ${Math.round(c.idleSeconds)} s${q}`;
  }
  return `${span} · ${KIND_LABEL[c.kind]}`;
}

function barHeight(c: TimelineColumn): number {
  switch (c.kind) {
    case 'activity':
      return Math.max(4, Math.round(c.share * 92));
    case 'none':
      return 3;
    default:
      return 92;
  }
}

export function Timeline({
  activity,
  sessions,
  dayFrom,
  dayTo,
  tz,
  isSelf,
}: {
  activity: ActivityResponse;
  sessions: readonly SessionDTO[];
  dayFrom: number;
  dayTo: number;
  tz: string;
  isSelf: boolean;
}) {
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);

  const { columns, runs, hours } = useMemo(() => {
    const times: number[] = [];
    for (const b of activity.buckets) times.push(Date.parse(b.bucket_start), Date.parse(b.bucket_start) + 60_000);
    for (const i of [...activity.pauses, ...activity.gaps]) times.push(Date.parse(i.from), Date.parse(i.to));
    for (const se of sessions) {
      times.push(Date.parse(se.started_at));
      if (se.ended_at) times.push(Date.parse(se.ended_at));
    }
    const win = timelineWindow(dayFrom, dayTo, times);
    const columns = buildTimelineColumns({ ...win, buckets: activity.buckets, pauses: activity.pauses, gaps: activity.gaps });
    const hours: { ms: number; left: number }[] = [];
    for (let t = win.from; t <= win.to; t += 3_600_000) hours.push({ ms: t, left: ((t - win.from) / (win.to - win.from)) * 100 });
    return { columns, runs: timelineRuns(columns), hours };
  }, [activity, sessions, dayFrom, dayTo]);

  const summary = describeTimeline(runs, (ms) => formatTime(ms, tz));
  const showAll = hours.length <= 13;

  return (
    <Card
      title="Computer activity through the day"
      actions={
        <button
          type="button"
          className="mono"
          style={{ background: 'none', border: 0, color: 'var(--link)', fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', minHeight: 44, padding: 0 }}
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'View as chart →' : 'View as table →'}
        </button>
      }
    >
      {showTable ? (
        <div id={tableId}>
          {runs.length === 0 ? (
            <p className="secondary">No sessions in this period.</p>
          ) : (
            <TableBox label="Activity periods">
              <table className={tableClass} style={{ minWidth: 520 }}>
                <caption className="visually-hidden">Activity periods for the day, in {tz}</caption>
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">What</th>
                    <th scope="col" className={numClass}>
                      Active
                    </th>
                    <th scope="col" className={numClass}>
                      Idle
                    </th>
                    <th scope="col" className={numClass}>
                      Computer activity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const pct = r.kind === 'activity' ? activityPercent(r.activeSeconds, r.idleSeconds) : null;
                    return (
                      <tr key={r.start}>
                        <td className="mono">
                          {formatTime(r.start, tz)}–{formatTime(r.end, tz)}
                        </td>
                        <td>{KIND_LABEL[r.kind]}</td>
                        <td className={numClass}>{r.kind === 'activity' ? formatDuration(r.activeSeconds) : '—'}</td>
                        <td className={numClass}>{r.kind === 'activity' ? formatDuration(r.idleSeconds) : '—'}</td>
                        <td className={numClass}>{pct === null ? '—' : `${pct}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableBox>
          )}
        </div>
      ) : (
        <div className={s.chart} role="img" aria-label={summary}>
          <div className={s.bars} aria-hidden="true">
            {columns.map((c) => (
              <div
                key={c.start}
                className={cx(s.bar, KIND_CLASS[c.kind])}
                style={{ height: barHeight(c) }}
                title={columnTitle(c, tz)}
              />
            ))}
          </div>
          <div className={s.hours} aria-hidden="true">
            {hours
              .filter((_, i) => showAll || i % 2 === 0 || i === hours.length - 1)
              .map((h) => (
                <span key={h.ms} style={{ left: `${h.left}%` }}>
                  {formatTime(h.ms, tz).slice(0, 2)}
                </span>
              ))}
          </div>
        </div>
      )}
      <div className={s.legend}>
        <span>
          <span className={cx(s.swatch, s.kindActivity)} aria-hidden="true" />
          Active minutes (height = share of the 5 min)
        </span>
        <span>
          <span className={cx(s.swatch, s.kindPaused)} aria-hidden="true" />
          Paused
        </span>
        <span>
          <span className={cx(s.swatch, s.kindOffline)} aria-hidden="true" />
          Asleep or offline
        </span>
        <span>
          <span className={cx(s.swatch, s.kindPermission)} aria-hidden="true" />
          No permission to measure
        </span>
        <span>
          <span className={s.swatchLine} aria-hidden="true" />
          No session
        </span>
      </div>
      <div className={s.explain} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <ActivityInfo />
        <span>
          Activity = active seconds ÷ (active + idle seconds) in minutes the agent could measure. It can&apos;t see
          meetings, calls, reading or thinking, so a low bar is not a judgement about {isSelf ? 'your' : 'anyone’s'} work.
        </span>
      </div>
    </Card>
  );
}
