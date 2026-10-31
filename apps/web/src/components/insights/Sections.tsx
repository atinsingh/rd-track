'use client';

import type { PersonalInsights } from '@rd/contracts';
import { ExpectedChart, ExpectedMeter, differenceText } from '@/components/insights/Expected';
import { Stats, statStyles } from '@/components/Stats';
import { Empty } from '@/components/ui/DataState';
import { Badge, Banner, Card, Meter, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { durationOrDash, formatDuration, formatPercent, percentOrDash } from '@/lib/format';
import { formatShortDay } from '@/lib/time';
import { t, tPlural } from '@/lib/i18n';

/** The sections of My insights, shared by the page and its printable copy (Stage 4 F9). */
export function Summary({ d }: { d: PersonalInsights }) {
  const e = d.expected;
  return (
    <Card title={t('ins.overview')}>
      <Stats
        items={[
          {
            label: t('ins.vsExpected'),
            value: (
              <>
                {formatDuration(e.tracked_seconds)} <span className="small secondary">{t('ins.of', { total: formatDuration(e.expected_seconds) })}</span>
              </>
            ),
            note: (
              <>
                <ExpectedMeter e={e} />
                {e.percent === null
                  ? t('ins.nothingExpected')
                  : t(e.source === 'schedule' ? 'ins.pctOfSchedule' : 'ins.pctOfExpected', { pct: formatPercent(e.percent), diff: differenceText(e) })}
              </>
            ),
          },
          {
            label: t('ins.focus'),
            value: formatDuration(d.focus.seconds),
            note: t('ins.focusNote', {
              blocks: tPlural(d.focus.blocks, 'ins.blocks.one', 'ins.blocks.other'),
              share: percentOrDash(d.focus.share_percent),
            }),
          },
          {
            label: t('ins.outside'),
            value: formatDuration(d.after_hours_seconds),
            note: `${t('ins.outsideNote', { start: d.working_hours.start, end: d.working_hours.end })}${d.weekend_seconds ? t('ins.weekend', { time: formatDuration(d.weekend_seconds) }) : ''}`,
          },
          {
            label: t('ins.typical'),
            value: d.typical_day.start ? `${d.typical_day.start}–${d.typical_day.stop}` : '—',
            note: d.typical_day.days
              ? t('ins.typicalNote', { idle: formatDuration(d.typical_day.idle_seconds ?? 0) })
              : t('ins.typicalNeeds'),
          },
        ]}
      />
    </Card>
  );
}

export function Wellbeing({ d }: { d: PersonalInsights }) {
  const flags = [
    d.long_days > 0 ? tPlural(d.long_days, 'ins.longDays.one', 'ins.longDays.other') : null,
    d.breakless_days > 0 ? tPlural(d.breakless_days, 'ins.breakless.one', 'ins.breakless.other') : null,
  ].filter(Boolean);
  if (flags.length === 0) return null;
  return (
    <Banner tone="warn" title={t('ins.worthLook')}>
      {t('ins.wellbeing', { flags: flags.join(' · '), stretch: formatDuration(d.longest_stretch_seconds) })}
    </Banner>
  );
}

export function WorkApps({ d }: { d: PersonalInsights }) {
  const total = d.work_apps.reduce((n, a) => n + a.seconds, 0);
  return (
    <Card title={t('ins.byCategory')} subtitle={t('ins.byCategorySub')}>
      {d.work_apps.length === 0 ? (
        <Empty title={t('ins.noApps')}>{t('ins.noAppsBody')}</Empty>
      ) : (
        <div className={statStyles.bars}>
          {d.work_apps.map((a) => (
            <div key={a.category} className={statStyles.barRow}>
              <span>{t(`ins.cat.${a.category}`)}</span>
              <Meter value={a.seconds} max={total} label={`${t(`ins.cat.${a.category}`)}: ${formatDuration(a.seconds)}`} />
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
    <Card title={d.expected.source === 'schedule' ? t('ins.vsSchedule') : t('ins.vsExpectedHours')}>
      <ExpectedChart e={d.expected} byWeek={byWeek} />
    </Card>
  );
}

export function Days({ d }: { d: PersonalInsights }) {
  const expected = new Map(d.expected.days.map((x) => [x.date, x.expected_seconds]));
  return (
    <Card title={t('ins.byDay')}>
      {d.days.length === 0 ? (
        <Empty title={t('ins.nothingTracked')} />
      ) : (
        <TableBox label={t('ins.byDayTable')}>
          <table className={tableClass} style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th scope="col">{t('ins.col.day')}</th>
                <th scope="col">{t('ins.col.startStop')}</th>
                <th scope="col" className={numClass}>
                  {t('ins.col.tracked')}
                </th>
                <th scope="col" className={numClass}>
                  {t('ins.col.expected')}
                </th>
                <th scope="col" className={numClass}>
                  {t('ins.col.focus')}
                </th>
                <th scope="col" className={numClass}>
                  {t('ins.col.outside')}
                </th>
                <th scope="col" className={numClass}>
                  {t('ins.col.idle')}
                </th>
                <th scope="col" className={numClass}>
                  {t('ins.col.longest')}
                </th>
                <th scope="col">
                  <span className="visually-hidden">{t('ins.col.notes')}</span>
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
                  <td className={numClass}>{day.weekend ? <span className="muted">{t('ins.weekendCell')}</span> : durationOrDash(day.after_hours_seconds)}</td>
                  <td className={numClass}>{durationOrDash(day.idle_seconds)}</td>
                  <td className={numClass}>{formatDuration(day.longest_stretch_seconds)}</td>
                  <td>
                    {day.long_day ? <Badge tone="warn">{t('ins.longDay')}</Badge> : null}{' '}
                    {day.longest_stretch_seconds > 4 * 3600 ? <Badge tone="warn">{t('ins.noBreak')}</Badge> : null}
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
