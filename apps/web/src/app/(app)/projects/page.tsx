'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { ProjectBudgetCard } from '@/components/ProjectBudgetCard';
import { StackedDailyChart } from '@/components/StackedDailyChart';
import { Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { InlineSelect } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, formatDuration } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import { NoAccess } from '../NoAccess';

export default function ProjectsPage() {
  const { access, timezone: tz } = useMe();
  // ?project= (from ⌘K) picks the project; choosing in the page wins until the link changes again.
  const requested = useSearchParams().get('project');
  const [choice, setChoice] = useState<{ from: string | null; id: string | null }>({ from: requested, id: requested });
  const projectId = choice.from === requested ? choice.id : requested;
  const setProjectId = (id: string | null) => setChoice({ from: requested, id });
  const [day, setDay] = useState(() => todayInTz(tz));
  const week = startOfWeek(day);
  const range = daysRange(week, 7, tz);
  const projects = useApi(access.managesProjects ? 'projects:managed' : null, (signal) => rd.projects.list(signal));
  const sorted = [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find((p) => p.id === projectId) ?? sorted[0];
  const report = useApi(current ? `project|${current.id}|${range.from}` : null, (signal) =>
    rd.projects.report(current!.id, { from: range.from, to: range.to }, signal),
  );

  if (!access.managesProjects) return <NoAccess what={t('mgr.proj.noAccess')} />;
  if (projects.error) return <ErrorState error={projects.error} onRetry={projects.reload} />;
  if (!projects.data) return <Loading label={t('mgr.proj.loading')} />;
  if (!current) return <Empty title={t('mgr.proj.none')} />;

  const total = report.data?.members.reduce((a, m) => a + m.seconds, 0) ?? 0;

  return (
    <>
      <PageHeader
        eyebrow={`${t('mgr.proj.eyebrow')}${current.client_ref ? ` · ${current.client_ref}` : ''}`}
        title={t('mgr.proj.title', { name: current.name })}
        description={t('mgr.proj.description')}
        actions={
          <>
            {sorted.length > 1 ? (
              <InlineSelect label={t('mgr.project')} value={current.id} onChange={(e) => setProjectId(e.target.value)}>
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
      <Banner tag="NOTE">{t('mgr.proj.note')}</Banner>
      <ProjectBudgetCard key={current.id} projectId={current.id} />
      {report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : !report.data ? (
        <Loading label={t('mgr.proj.loadingReport')} />
      ) : (
        <>
          <Card title={t('mgr.proj.people')} subtitle={t('mgr.proj.total', { total: formatDuration(total) })}>
            {report.data.members.length === 0 ? (
              <Empty title={t('mgr.proj.noTime')} />
            ) : (
              <TableBox label={t('mgr.proj.perPerson')}>
                <table className={tableClass} style={{ minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th scope="col" aria-sort="ascending">
                        {t('mgr.col.nameSorted')}
                      </th>
                      <th scope="col" className={numClass}>
                        {t('mgr.proj.timeOn')}
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
            title={t('mgr.proj.chart')}
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
