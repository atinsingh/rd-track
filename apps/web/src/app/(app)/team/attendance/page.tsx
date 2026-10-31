'use client';

import { useState } from 'react';
import type { TeamAttendanceResponse, TeamCalendarResponse } from '@rd/contracts';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { AttendanceCell, AttendanceLegend, CalendarCell } from '@/components/scheduling/Attendance';
import s from '@/components/scheduling/scheduling.module.css';
import { Empty, ErrorState, Loading, Resource } from '@/components/ui/DataState';
import { InlineSelect, Segmented } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { sched, weekLabel } from '@/lib/scheduling';
import { addDays, formatShortDay, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import { NoAccess } from '../../NoAccess';

type View = 'attendance' | 'calendar';

function DayHeads({ days, today }: { days: string[]; today: string }) {
  return (
    <>
      {days.map((d) => (
        <th key={d} scope="col" className={d === today ? s.todayHead : undefined}>
          {formatShortDay(d)}
          {d === today ? <span className="visually-hidden">{t('mgr.today')}</span> : null}
        </th>
      ))}
    </>
  );
}

function AttendanceGrid({ data, tz, today }: { data: TeamAttendanceResponse; tz: string; today: string }) {
  if (data.members.length === 0) return <Empty title={t('mgr.team.noMembers')} />;
  const days = data.members[0]!.days.map((d) => d.date);
  return (
    <TableBox label={t('mgr.att.label')}>
      <table className={s.grid}>
        <caption className="visually-hidden">{t('mgr.att.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('mgr.col.nameSorted')}</th>
            <DayHeads days={days} today={today} />
          </tr>
        </thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.user_id}>
              <th scope="row" className={s.name}>
                {m.display_name}
              </th>
              {m.days.map((d) => (
                <td key={d.date}>
                  <AttendanceCell day={d} tz={tz} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableBox>
  );
}

function CalendarGrid({ data, today }: { data: TeamCalendarResponse; today: string }) {
  if (data.members.length === 0) return <Empty title={t('mgr.team.noMembers')} />;
  const days = data.members[0]!.days.map((d) => d.date);
  const offCount = data.members.filter((m) => m.days.some((d) => d.off)).length;
  return (
    <>
      <p className="small secondary">
        {offCount === 0 ? t('mgr.att.nobodyOff') : tPlural(offCount, 'mgr.att.off.one', 'mgr.att.off.other')} {t('mgr.att.private')}
      </p>
      <TableBox label={t('mgr.att.whosOff')}>
        <table className={s.grid}>
          <caption className="visually-hidden">{t('mgr.att.calCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('mgr.col.nameSorted')}</th>
              <DayHeads days={days} today={today} />
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.user_id}>
                <th scope="row" className={s.name}>
                  {m.display_name}
                </th>
                {m.days.map((d) => (
                  <td key={d.date}>
                    <CalendarCell day={d} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
    </>
  );
}

export default function TeamAttendancePage() {
  const { access, me, timezone: tz } = useMe();
  const schedules = me.entitlements.includes('schedules');
  const timeOff = me.entitlements.includes('time_off');
  const allowed = access.managesTeams && (schedules || timeOff);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [view, setView] = useState<View>(schedules ? 'attendance' : 'calendar');
  const [day, setDay] = useState(() => todayInTz(tz));
  const week = startOfWeek(day);
  const range = { from: week, to: addDays(week, 6) };
  const today = todayInTz(tz);
  const teams = useApi(allowed ? 'teams' : null, (signal) => rd.teams.list(signal));
  const sorted = [...(teams.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find((t) => t.id === teamId) ?? sorted[0];
  const attendance = useApi(current && view === 'attendance' && schedules ? `team:attendance|${current.id}|${week}` : null, (signal) =>
    sched.team.attendance(current!.id, range, signal),
  );
  const calendar = useApi(current && view === 'calendar' ? `team:calendar|${current.id}|${week}` : null, (signal) =>
    sched.team.calendar(current!.id, range, signal),
  );

  if (!allowed) return <NoAccess what={t('mgr.att.noAccess')} />;
  if (teams.error) return <ErrorState error={teams.error} onRetry={teams.reload} />;
  if (!teams.data) return <Loading label={t('mgr.team.loadingTeams')} />;
  if (!current) return <Empty title={t('mgr.team.noTeams')} />;

  return (
    <>
      <PageHeader
        eyebrow={tPlural(current.member_count, 'mgr.team.eyebrow.one', 'mgr.team.eyebrow.other')}
        title={t('mgr.att.title', { name: current.name })}
        description={t('mgr.att.description')}
        actions={
          <>
            {sorted.length > 1 ? (
              <InlineSelect label={t('nav.team')} value={current.id} onChange={(e) => setTeamId(e.target.value)}>
                {sorted.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </InlineSelect>
            ) : null}
            <DateSwitcher
              date={day}
              onDate={setDay}
              tz={tz}
              step={7}
              unit="week"
              label={`${week === startOfWeek(today) ? t('ts.thisWeekPrefix') : ''}${weekLabel(range.from, range.to)}`}
            />
          </>
        }
      />
      <Segmented<View>
        legend={t('shell.view')}
        name="team-schedule-view"
        value={view}
        onChange={setView}
        options={[
          { value: 'attendance', label: t('sched.attendance'), disabled: !schedules },
          { value: 'calendar', label: t('mgr.att.whosOff') },
        ]}
      />
      <Banner tag="NOTE">
        {t('mgr.att.note')}
      </Banner>
      {view === 'attendance' ? (
        <Card title={t('sched.attendance')} subtitle={weekLabel(range.from, range.to)}>
          <Resource {...attendance} label={t('mgr.att.loading')}>
            {(data) => (
              <>
                <AttendanceGrid data={data} tz={tz} today={today} />
                <AttendanceLegend />
                <p className="small muted">
                  {t('mgr.att.lateNote', { late: data.late_grace_minutes, early: data.early_leave_grace_minutes })}
                </p>
              </>
            )}
          </Resource>
        </Card>
      ) : (
        <Card title={t('mgr.att.whosOff')} subtitle={weekLabel(range.from, range.to)}>
          <Resource {...calendar} label={t('mgr.att.loadingCal')}>
            {(data) => <CalendarGrid data={data} today={today} />}
          </Resource>
        </Card>
      )}
    </>
  );
}
