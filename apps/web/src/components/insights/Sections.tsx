'use client';

import { APP_CATEGORY_LABELS, type PersonalInsights } from '@rd/contracts';
import { ExpectedChart, ExpectedMeter, differenceText } from '@/components/insights/Expected';
import { Stats, statStyles } from '@/components/Stats';
import { Empty } from '@/components/ui/DataState';
import { Badge, Banner, Card, Meter, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { durationOrDash, formatDuration, percentOrDash, plural } from '@/lib/format';
import { formatShortDay } from '@/lib/time';

/** The sections of My insights, shared by the page and its printable copy (Stage 4 F9). */
export function Summary({ d }: { d: PersonalInsights }) {
  const e = d.expected;
  return (
    <Card title="Overview">
      <Stats
        items={[
          {
            label: 'Tracked vs expected',
            value: (
              <>
                {formatDuration(e.tracked_seconds)} <span className="small secondary">of {formatDuration(e.expected_seconds)}</span>
              </>
            ),
            note: (
              <>
                <ExpectedMeter e={e} />
                {e.percent === null ? 'Nothing expected in this period' : `${e.percent}% of ${e.source === 'schedule' ? 'your schedule' : 'expected'} · ${differenceText(e)}`}
              </>
            ),
          },
          {
            label: 'Focus time',
            value: formatDuration(d.focus.seconds),
            note: `${plural(d.focus.blocks, 'block')} · ${percentOrDash(d.focus.share_percent)} of tracked`,
          },
          {
            label: 'Outside working hours',
            value: formatDuration(d.after_hours_seconds),
            note: `Weekdays before ${d.working_hours.start} or after ${d.working_hours.end}${d.weekend_seconds ? ` · ${formatDuration(d.weekend_seconds)} at the weekend` : ''}`,
          },
          {
            label: 'Typical day',
            value: d.typical_day.start ? `${d.typical_day.start}–${d.typical_day.stop}` : '—',
            note: d.typical_day.days
              ? `Average first start and last stop · ${formatDuration(d.typical_day.idle_seconds ?? 0)} idle a day`
              : 'Needs a day with half an hour tracked',
          },
        ]}
      />
    </Card>
  );
}

export function Wellbeing({ d }: { d: PersonalInsights }) {
  const flags = [
    d.long_days > 0 ? `${plural(d.long_days, 'day')} over 10 hours` : null,
    d.breakless_days > 0 ? `${plural(d.breakless_days, 'day')} with more than 4 hours without a 10-minute break` : null,
  ].filter(Boolean);
  if (flags.length === 0) return null;
  return (
    <Banner tone="warn" title="Worth a look">
      {flags.join(' · ')}. Longest stretch without a break: {formatDuration(d.longest_stretch_seconds)}. These are for you — consider
      blocking breaks in your calendar.
    </Banner>
  );
}

export function WorkApps({ d }: { d: PersonalInsights }) {
  const total = d.work_apps.reduce((n, a) => n + a.seconds, 0);
  return (
    <Card title="Time by app category" subtitle="Categories are set by your organization">
      {d.work_apps.length === 0 ? (
        <Empty title="No app usage in this period">App names are only recorded when your organization&apos;s policy turns them on.</Empty>
      ) : (
        <div className={statStyles.bars}>
          {d.work_apps.map((a) => (
            <div key={a.category} className={statStyles.barRow}>
              <span>{APP_CATEGORY_LABELS[a.category]}</span>
              <Meter value={a.seconds} max={total} label={`${APP_CATEGORY_LABELS[a.category]}: ${formatDuration(a.seconds)}`} />
              <span className="mono" style={{ textAlign: 'right' }}>
                {formatDuration(a.seconds)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AgainstExpected({ d, byWeek }: { d: PersonalInsights; byWeek: boolean }) {
  return (
    <Card title={d.expected.source === 'schedule' ? 'Each day against your schedule' : 'Each day against your expected hours'}>
      <ExpectedChart e={d.expected} byWeek={byWeek} />
    </Card>
  );
}

export function Days({ d }: { d: PersonalInsights }) {
  const expected = new Map(d.expected.days.map((x) => [x.date, x.expected_seconds]));
  return (
    <Card title="By day">
      {d.days.length === 0 ? (
        <Empty title="Nothing tracked in this period" />
      ) : (
        <TableBox label="Insights by day">
          <table className={tableClass} style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Start–stop</th>
                <th scope="col" className={numClass}>
                  Tracked
                </th>
                <th scope="col" className={numClass}>
                  Expected
                </th>
                <th scope="col" className={numClass}>
                  Focus
                </th>
                <th scope="col" className={numClass}>
                  Outside hours
                </th>
                <th scope="col" className={numClass}>
                  Idle
                </th>
                <th scope="col" className={numClass}>
                  Longest stretch
                </th>
                <th scope="col">
                  <span className="visually-hidden">Notes</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.days.map((day) => (
                <tr key={day.date}>
                  <td>{formatShortDay(day.date)}</td>
                  <td className="mono small">
                    {day.first_start}–{day.last_stop}
                  </td>
                  <td className={numClass}>{formatDuration(day.tracked_seconds)}</td>
                  <td className={numClass}>{durationOrDash(expected.get(day.date) ?? 0)}</td>
                  <td className={numClass}>
                    {durationOrDash(day.focus_seconds)}
                    {day.focus_blocks > 1 ? <span className="small muted"> · {day.focus_blocks}</span> : null}
                  </td>
                  <td className={numClass}>{day.weekend ? <span className="muted">weekend</span> : durationOrDash(day.after_hours_seconds)}</td>
                  <td className={numClass}>{durationOrDash(day.idle_seconds)}</td>
                  <td className={numClass}>{formatDuration(day.longest_stretch_seconds)}</td>
                  <td>
                    {day.long_day ? <Badge tone="warn">Long day</Badge> : null}{' '}
                    {day.longest_stretch_seconds > 4 * 3600 ? <Badge tone="warn">No break</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
    </Card>
  );
}
