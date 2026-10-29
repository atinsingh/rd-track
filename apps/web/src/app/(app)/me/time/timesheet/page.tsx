'use client';

import { useState } from 'react';
import { isoWeekStart } from '@rd/contracts';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { StatusBadge, TimesheetView } from '@/components/timesheet/TimesheetView';
import { TimeTabs } from '@/components/timesheet/TimeTabs';
import { Button } from '@/components/ui/Button';
import { ActionError, Resource } from '@/components/ui/DataState';
import { TextArea } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, formActionsClass, numClass, tableClass } from '@/components/ui/Layout';
import { durationOrDash, formatDuration } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, formatDayMonth, todayInTz } from '@/lib/time';
import { formatLimitMinutes, overtimeText, timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import { NoAccess } from '../../../NoAccess';

export default function MyTimesheetPage() {
  const { access, timezone: tz } = useMe();
  const entitled = access.entitlements.includes('timesheets');
  const today = todayInTz(tz);
  const [day, setDay] = useState(today);
  const [note, setNote] = useState('');
  const week = isoWeekStart(day);
  const sheet = useApi(entitled ? `me:timesheet|${week}` : null, (signal) => timesheetsApi.myWeek(week, signal));
  const recentFrom = addDays(isoWeekStart(today), -7 * 7);
  const recent = useApi(entitled ? `me:timesheets|${recentFrom}|${today}` : null, (signal) =>
    timesheetsApi.mine(recentFrom, today, signal),
  );
  const limits = useApi(entitled ? 'me:work-limits' : null, (signal) => timesheetsApi.myLimits(signal));
  const submit = useAction();

  if (!entitled) return <NoAccess what={t('ts.noAccess')} />;

  const doSubmit = async () => {
    const r = await submit.run(() => timesheetsApi.submit(week, note.trim() || undefined));
    if (r) {
      sheet.mutate(() => r);
      setNote('');
      recent.reload();
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('time.eyebrow')}
        title={t('time.title')}
        description={t('ts.description')}
        actions={
          <DateSwitcher
            date={day}
            onDate={setDay}
            tz={tz}
            step={7}
            unit="week"
            max={today}
            label={`${week === isoWeekStart(today) ? t('ts.thisWeekPrefix') : ''}${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
          />
        }
      />
      <TimeTabs current="timesheets" />

      {limits.data && (limits.data.limits.daily_minutes !== null || limits.data.limits.weekly_minutes !== null) ? (
        <Banner tag="LIMITS">
          {limits.data.limits.daily_minutes !== null
            ? t('ts.limitsToday', { worked: formatDuration(limits.data.today.worked_seconds), limit: formatLimitMinutes(limits.data.limits.daily_minutes) })
            : ''}
          {limits.data.limits.weekly_minutes !== null
            ? t('ts.limitsWeek', { worked: formatDuration(limits.data.week.worked_seconds), limit: formatLimitMinutes(limits.data.limits.weekly_minutes) })
            : ''}
          {limits.data.week.overtime_seconds > 0 ? t('ts.overSoFar', { over: formatDuration(limits.data.week.overtime_seconds) }) : ''}
        </Banner>
      ) : null}

      <Resource {...sheet} label={t('ts.loading')}>
        {(ts) => (
          <>
            <TimesheetView sheet={ts} tz={tz} self />
            {ts.can_submit ? (
              <Card title={t('ts.submitTitle')} subtitle={t('ts.submitSub')}>
                <TextArea
                  label={t('ts.noteLabel')}
                  rows={2}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <ActionError error={submit.error} />
                <div className={formActionsClass}>
                  <Button variant="primary" onClick={doSubmit} disabled={submit.busy}>
                    {submit.busy ? t('ts.submitting') : t('ts.submit')}
                  </Button>
                </div>
              </Card>
            ) : null}
          </>
        )}
      </Resource>

      <Card title={t('ts.recent')}>
        <Resource {...recent} label={t('ts.loadingRecent')}>
          {(list) => (
            <TableBox label={t('ts.recent')}>
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('ts.col.week')}</th>
                    <th scope="col">{t('ts.col.status')}</th>
                    <th scope="col" className={numClass}>
                      {t('ts.col.total')}
                    </th>
                    <th scope="col" className={numClass}>
                      {t('ts.col.over')}
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">{t('ts.col.open')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...list]
                    .sort((a, b) => b.period_start.localeCompare(a.period_start))
                    .map((w) => (
                      <tr key={w.period_start}>
                        <td className="mono">
                          {formatDayMonth(w.period_start)} – {formatDayMonth(addDays(w.period_start, 6))}
                        </td>
                        <td>
                          <StatusBadge status={w.status} />
                        </td>
                        <td className={numClass}>{durationOrDash(w.total_seconds)}</td>
                        <td className={numClass}>{overtimeText(w.overtime_seconds)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {w.period_start === week ? (
                            <span className="small muted">{t('ts.showing')}</span>
                          ) : (
                            <Button size="sm" variant="quiet" onClick={() => setDay(w.period_start)}>
                              {t('ts.open')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </TableBox>
          )}
        </Resource>
      </Card>
    </>
  );
}
