'use client';

import { useState } from 'react';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { StackedDailyChart } from '@/components/StackedDailyChart';
import { Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { InlineSelect } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, formatDuration } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { NoAccess } from '../NoAccess';

export default function ProjectsPage() {
  const { access, timezone: tz } = useMe();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [day, setDay] = useState(() => todayInTz(tz));
  const week = startOfWeek(day);
  const range = daysRange(week, 7, tz);
  const projects = useApi(access.managesProjects ? 'projects:managed' : null, (signal) => rd.projects.list(signal));
  const sorted = [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find((p) => p.id === projectId) ?? sorted[0];
  const report = useApi(current ? `project|${current.id}|${range.from}` : null, (signal) =>
    rd.projects.report(current!.id, { from: range.from, to: range.to }, signal),
  );

  if (!access.managesProjects) return <NoAccess what="Project reports are for project managers." />;
  if (projects.error) return <ErrorState error={projects.error} onRetry={projects.reload} />;
  if (!projects.data) return <Loading label="Loading your projects" />;
  if (!current) return <Empty title="You don't manage any projects yet" />;

  const total = report.data?.members.reduce((a, m) => a + m.seconds, 0) ?? 0;

  return (
    <>
      <PageHeader
        eyebrow={`Project manager${current.client_ref ? ` · ${current.client_ref}` : ''}`}
        title={`Project · ${current.name}`}
        description="Time per person on this project. Project managers see time only — no computer activity, apps or screenshots."
        actions={
          <>
            {sorted.length > 1 ? (
              <InlineSelect label="Project" value={current.id} onChange={(e) => setProjectId(e.target.value)}>
                {sorted.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
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
              label={`${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
            />
          </>
        }
      />
      <Banner tag="NOTE">Sorted by name. Hours include agent-tracked and approved manual time.</Banner>
      {report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : !report.data ? (
        <Loading label="Loading the project report" />
      ) : (
        <>
          <Card title="People on this project" subtitle={`${formatDuration(total)} in total`}>
            {report.data.members.length === 0 ? (
              <Empty title="No time on this project in this period" />
            ) : (
              <TableBox label="Time per person">
                <table className={tableClass} style={{ minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th scope="col" aria-sort="ascending">
                        Name ▴
                      </th>
                      <th scope="col" className={numClass}>
                        Time on project
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...report.data.members].sort(byName).map((m) => (
                      <tr key={m.user_id}>
                        <td style={{ fontWeight: 600 }}>{m.display_name}</td>
                        <td className={numClass}>{formatDuration(m.seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            )}
          </Card>
          <StackedDailyChart
            title="Hours on this project, per day"
            tz={tz}
            singleSeriesName={current.name}
            daily={report.data.daily.map((d) => ({
              date: d.date,
              projects: [{ project_id: current.id, project_name: current.name, seconds: d.seconds }],
            }))}
          />
        </>
      )}
    </>
  );
}
