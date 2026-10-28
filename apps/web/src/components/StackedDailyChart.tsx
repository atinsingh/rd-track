'use client';

import { useId, useState, type CSSProperties } from 'react';
import type { DailyProjectRow } from '@rd/contracts';
import { Card, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { Empty } from '@/components/ui/DataState';
import { stackDaily } from '@/lib/charts';
import { cx } from '@/lib/cx';
import { formatDuration, formatHoursShort } from '@/lib/format';
import { formatShortDay, todayInTz } from '@/lib/time';
import s from './chart.module.css';

/** Daily hours stacked by project, with a table alternative (UX §3.4). */
export function StackedDailyChart({
  title,
  daily,
  tz,
  singleSeriesName,
}: {
  title: string;
  daily: readonly DailyProjectRow[];
  tz: string;
  /** label for the legend when there is just one series (project report) */
  singleSeriesName?: string;
}) {
  const id = useId();
  const [table, setTable] = useState(false);
  const chart = stackDaily(daily);
  const today = todayInTz(tz);
  const H = 196;
  const summary =
    chart.days.length === 0
      ? 'No tracked time in this period.'
      : `Daily tracked hours: ${chart.days
          .map((d) => `${formatShortDay(d.date)} ${formatHoursShort(d.total)}`)
          .join(', ')}. Largest project overall: ${chart.series[0]?.name ?? 'none'}.`;

  return (
    <Card
      title={title}
      actions={
        <button type="button" className={s.toggle} aria-expanded={table} aria-controls={id} onClick={() => setTable((v) => !v)}>
          {table ? 'View as chart →' : 'View as table →'}
        </button>
      }
    >
      {chart.series.length > 0 ? (
        <div className={s.legend}>
          {chart.series.map((x) => (
            <span key={x.id}>
              <span className={cx(s.swatch, s[x.fill])} aria-hidden="true" />
              {chart.series.length === 1 && singleSeriesName ? singleSeriesName : x.name}
            </span>
          ))}
        </div>
      ) : null}
      {chart.max === 0 ? (
        <Empty title="No tracked time in this period" />
      ) : table ? (
        <div id={id}>
          <TableBox label={title}>
            <table className={tableClass} style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  {chart.series.map((x) => (
                    <th key={x.id} scope="col" className={numClass}>
                      {x.name}
                    </th>
                  ))}
                  <th scope="col" className={numClass}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {chart.days.map((d) => (
                  <tr key={d.date}>
                    <th scope="row" style={{ fontFamily: 'inherit', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text)', border: 0, borderBottom: '1px solid var(--rule-soft)', fontWeight: 500 }}>
                      {formatShortDay(d.date)}
                    </th>
                    {chart.series.map((x) => (
                      <td key={x.id} className={numClass}>
                        {formatDuration(d.segments.find((g) => g.seriesId === x.id)?.seconds ?? 0)}
                      </td>
                    ))}
                    <td className={numClass}>{formatDuration(d.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        </div>
      ) : (
        <div role="img" aria-label={summary} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className={s.plot} style={{ '--days': chart.days.length } as CSSProperties} aria-hidden="true">
            {chart.days.map((d) => (
              <div key={d.date} className={s.day}>
                <span className={s.total}>{d.total > 0 ? formatHoursShort(d.total) : ''}</span>
                <div className={s.stack}>
                  {d.segments.map((g) => {
                    const series = chart.series.find((x) => x.id === g.seriesId);
                    return (
                      <div
                        key={g.seriesId}
                        className={cx(s.seg, series && s[series.fill])}
                        style={{ height: Math.max(2, Math.round((g.seconds / chart.max) * H)) }}
                        title={`${series?.name ?? ''}: ${formatDuration(g.seconds)}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className={s.labels} style={{ '--days': chart.days.length } as CSSProperties} aria-hidden="true">
            {chart.days.map((d) => (
              <span key={d.date}>
                {formatShortDay(d.date).replace(/ \w+$/, '')}
                {d.date === today ? ' · so far' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
