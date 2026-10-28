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
import { plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { sched, weekLabel } from '@/lib/scheduling';
import { addDays, formatShortDay, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

type View = 'attendance' | 'calendar';

function DayHeads({ days, today }: { days: string[]; today: string }) {
  return (
    <>
      {days.map((d) => (
        <th key={d} scope="col" className={d === today ? s.todayHead : undefined}>
          {formatShortDay(d)}
          {d === today ? <span className="visually-hidden"> (today)</span> : null}
        </th>
      ))}
    </>
  );
}

function AttendanceGrid({ data, tz, today }: { data: TeamAttendanceResponse; tz: string; today: string }) {
  if (data.members.length === 0) return <Empty title="No members in this team yet" />;
  const days = data.members[0]!.days.map((d) => d.date);
  return (
    <TableBox label="Team attendance">
      <table className={s.grid}>
        <caption className="visually-hidden">Attendance by person and day, sorted by name</caption>
        <thead>
          <tr>
            <th scope="col">Name ▴</th>
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
  if (data.members.length === 0) return <Empty title="No members in this team yet" />;
  const days = data.members[0]!.days.map((d) => d.date);
  const offCount = data.members.filter((m) => m.days.some((d) => d.off)).length;
  return (
    <>
      <p className="small secondary">
        {offCount === 0 ? 'Nobody has approved time off this week.' : `${plural(offCount, 'person', 'people')} with approved time off this week.`} Policy names and
        reasons stay private; you see them only when reviewing a request.
      </p>
      <TableBox label="Who's off">
        <table className={s.grid}>
          <caption className="visually-hidden">Approved time off, holidays and shifts by person and day</caption>
          <thead>
            <tr>
              <th scope="col">Name ▴</th>
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

  if (!allowed) return <NoAccess what="Team attendance and the time-off calendar are for team managers on plans with schedules or time off." />;
  if (teams.error) return <ErrorState error={teams.error} onRetry={teams.reload} />;
  if (!teams.data) return <Loading label="Loading your teams" />;
  if (!current) return <Empty title="You don't manage any teams yet" />;

  return (
    <>
      <PageHeader
        eyebrow={`Team manager · ${plural(current.member_count, 'member')}`}
        title={`Attendance · ${current.name}`}
        description="How recorded time lines up with each person's schedule, and who is off. Each person sees their own attendance first, with the same statuses."
        actions={
          <>
            {sorted.length > 1 ? (
              <InlineSelect label="Team" value={current.id} onChange={(e) => setTeamId(e.target.value)}>
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
              label={`${week === startOfWeek(today) ? 'This week · ' : ''}${weekLabel(range.from, range.to)}`}
            />
          </>
        }
      />
      <Segmented<View>
        legend="View"
        name="team-schedule-view"
        value={view}
        onChange={setView}
        options={[
          { value: 'attendance', label: 'Attendance', disabled: !schedules },
          { value: 'calendar', label: "Who's off" },
        ]}
      />
      <Banner tag="NOTE">
        Sorted by name. Attendance compares recorded time with the schedule — it isn&apos;t a measure of performance, and a late start or a gap can have
        reasons the record can&apos;t see. Opening this view is recorded in each person&apos;s &ldquo;Who viewed my data&rdquo;.
      </Banner>
      {view === 'attendance' ? (
        <Card title="Attendance" subtitle={weekLabel(range.from, range.to)}>
          <Resource {...attendance} label="Loading attendance">
            {(data) => (
              <>
                <AttendanceGrid data={data} tz={tz} today={today} />
                <AttendanceLegend />
                <p className="small muted">
                  Late means the first recorded time began more than {data.late_grace_minutes} min after the shift start; left early means it ended more
                  than {data.early_leave_grace_minutes} min before the shift end. Shift times are in each person&apos;s schedule time zone.
                </p>
              </>
            )}
          </Resource>
        </Card>
      ) : (
        <Card title="Who's off" subtitle={weekLabel(range.from, range.to)}>
          <Resource {...calendar} label="Loading the calendar">
            {(data) => <CalendarGrid data={data} today={today} />}
          </Resource>
        </Card>
      )}
    </>
  );
}
