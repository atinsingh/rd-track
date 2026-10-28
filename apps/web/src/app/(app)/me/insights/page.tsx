'use client';

import { useState } from 'react';
import { APP_CATEGORY_LABELS, type PersonalInsights } from '@rd/contracts';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { Stats, statStyles } from '@/components/Stats';
import { Empty, Resource } from '@/components/ui/DataState';
import { Segmented } from '@/components/ui/Field';
import { Badge, Banner, Card, Meter, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { durationOrDash, formatDuration, percentOrDash, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, formatShortDay, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';

type Period = 'week' | 'four_weeks';

function Summary({ d }: { d: PersonalInsights }) {
  return (
    <Card title="Overview">
      <Stats
        items={[
          { label: 'Tracked', value: formatDuration(d.tracked_seconds) },
          {
            label: 'Focus time',
            value: formatDuration(d.focus.seconds),
            note: `${plural(d.focus.blocks, 'block')} · ${percentOrDash(d.focus.share_percent)} of tracked`,
          },
          {
            label: 'Outside working hours',
            value: formatDuration(d.after_hours_seconds),
            note: `Weekdays before ${d.working_hours.start} or after ${d.working_hours.end}`,
          },
          { label: 'Weekend', value: formatDuration(d.weekend_seconds) },
        ]}
      />
    </Card>
  );
}

function Wellbeing({ d }: { d: PersonalInsights }) {
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

function WorkApps({ d }: { d: PersonalInsights }) {
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

function Days({ d }: { d: PersonalInsights }) {
  return (
    <Card title="By day">
      {d.days.length === 0 ? (
        <Empty title="Nothing tracked in this period" />
      ) : (
        <TableBox label="Insights by day">
          <table className={tableClass} style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className={numClass}>
                  Tracked
                </th>
                <th scope="col" className={numClass}>
                  Focus
                </th>
                <th scope="col" className={numClass}>
                  Outside hours
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
                  <td className={numClass}>{formatDuration(day.tracked_seconds)}</td>
                  <td className={numClass}>
                    {durationOrDash(day.focus_seconds)}
                    {day.focus_blocks > 1 ? <span className="small muted"> · {day.focus_blocks}</span> : null}
                  </td>
                  <td className={numClass}>{day.weekend ? <span className="muted">weekend</span> : durationOrDash(day.after_hours_seconds)}</td>
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

export default function MyInsightsPage() {
  const { timezone } = useMe();
  const [tz, setTz] = useState(timezone);
  const [day, setDay] = useState(() => todayInTz(timezone));
  const [period, setPeriod] = useState<Period>('week');
  const days = period === 'week' ? 7 : 28;
  const start = period === 'week' ? startOfWeek(day) : addDays(startOfWeek(day), -21);
  const range = daysRange(start, days, tz);
  const insights = useApi(`me:insights|${range.from}|${range.to}|${tz}`, (signal) => rd.my.insights(range, tz, signal));

  return (
    <>
      <PageHeader
        eyebrow="Employee · Insights"
        title="Insights"
        description="Focus time, working hours and breaks, worked out from your own activity. Per-person insights are visible to you only."
        actions={
          <>
            <Segmented<Period>
              legend="Period"
              name="period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'week', label: 'Week' },
                { value: 'four_weeks', label: '4 weeks' },
              ]}
            />
            <DateSwitcher
              date={day}
              onDate={setDay}
              tz={tz}
              onTz={setTz}
              step={7}
              unit="week"
              max={todayInTz(tz)}
              label={`${formatDayMonth(start)} – ${formatDayMonth(addDays(start, days - 1))}`}
            />
          </>
        }
      />
      <Banner tag="NOTE">
        A focus block is 30 minutes or more of continuous activity in one session. Quiet minutes (reading, thinking) don&apos;t break it,
        and minutes without input permission never count. Computer activity is not a measure of performance.
      </Banner>
      <Resource {...insights} label="Working out your insights">
        {(d) => (
          <>
            <Wellbeing d={d} />
            <Summary d={d} />
            <WorkApps d={d} />
            <Days d={d} />
          </>
        )}
      </Resource>
    </>
  );
}
