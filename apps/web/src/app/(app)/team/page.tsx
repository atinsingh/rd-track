'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CorrectionDTO, MemberReportRow, TeamReport } from '@rd/contracts';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { StackedDailyChart } from '@/components/StackedDailyChart';
import { ActivityInfo } from '@/components/ui/ActivityInfo';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { InlineSelect } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, durationOrDash, formatDuration, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../NoAccess';
import s from './team.module.css';

function memberHref(m: MemberReportRow, teamId: string, week: string): string {
  const q = new URLSearchParams({ team: teamId, name: m.display_name, date: week });
  return `/team/${encodeURIComponent(m.user_id)}?${q.toString()}`;
}

function Attention({ report, pending }: { report: TeamReport; pending: CorrectionDTO[] }) {
  const ids = new Set(report.members.map((m) => m.user_id));
  const mine = pending.filter((c) => ids.has(c.user_id));
  const withNotes = [...report.members].sort(byName).filter((m) => m.notes.length > 0);
  const first = mine[0];
  return (
    <Card title="Needs your attention" as="aside" className={s.attention}>
      {mine.length > 0 ? (
        <Link href="/approvals" className={s.attItem}>
          <span className={s.attTitle}>{plural(mine.length, 'correction')} to review →</span>
          {first ? (
            <span className={s.attBody}>
              {first.user_name} · {first.kind === 'manual_add' ? 'manual time' : 'edit'} · “{first.reason}”
            </span>
          ) : null}
        </Link>
      ) : (
        <div className={s.attItem}>
          <span className={s.attTitle}>No corrections waiting</span>
          <span className={s.attBody}>New requests from your team appear here and in Approvals.</span>
        </div>
      )}
      {withNotes.length > 0 ? (
        <div className={`${s.attItem} ${s.attWarn}`}>
          <span className={s.attTitle}>Data notes for {plural(withNotes.length, 'person', 'people')}</span>
          <span className={s.attBody}>
            {withNotes
              .slice(0, 3)
              .map((m) => `${m.display_name}: ${m.notes.join('; ')}`)
              .join(' · ')}
            . Unmeasured minutes are marked as such, not as idle.
          </span>
        </div>
      ) : null}
      <div className={s.attItem}>
        <span className={s.attTitle}>Screenshots</span>
        <span className={s.attBody}>
          {report.visibility.screenshots
            ? 'Policy lets you view screenshots for some members. Every view is recorded and shown to the employee.'
            : "Screenshots aren't shared with you for this team."}
        </span>
      </div>
    </Card>
  );
}

function MembersTable({ report, week }: { report: TeamReport; week: string }) {
  const rows = [...report.members].sort(byName);
  const showActivity = report.visibility.activity;
  if (rows.length === 0) return <Empty title="No members in this team yet" />;
  return (
    <TableBox label="Team members">
      <table className={tableClass} style={{ minWidth: 680 }}>
        <caption className="visually-hidden">Team members sorted by name</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort="ascending">
              Name ▴
            </th>
            <th scope="col" className={numClass}>
              Tracked
            </th>
            {showActivity ? (
              <th scope="col">
                <span className={s.thActivity}>
                  Activity <ActivityInfo />
                </span>
              </th>
            ) : null}
            <th scope="col" className={numClass}>
              Not measured
            </th>
            <th scope="col" className={numClass}>
              Manual
            </th>
            <th scope="col" className={numClass}>
              Days
            </th>
            <th scope="col">Data notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.user_id}>
              <td>
                <Link href={memberHref(m, report.team.id, week)} className={s.memberLink}>
                  {m.display_name}
                </Link>
              </td>
              <td className={numClass}>{formatDuration(m.tracked_seconds)}</td>
              {showActivity ? (
                <td>
                  {m.activity_percent === null ? (
                    <span className="mono muted">—</span>
                  ) : (
                    <span className={s.act}>
                      <span className={s.actNum}>{m.activity_percent}%</span>
                      <span className={s.actTrack} aria-hidden="true">
                        <span className={s.actFill} style={{ width: `${m.activity_percent}%` }} />
                      </span>
                    </span>
                  )}
                </td>
              ) : null}
              <td className={numClass}>{durationOrDash(m.gap_seconds + m.paused_seconds)}</td>
              <td className={numClass}>{durationOrDash(m.manual_seconds)}</td>
              <td className={numClass}>{m.days_active}</td>
              <td className="small secondary">{m.notes.length ? m.notes.join('; ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableBox>
  );
}

export default function TeamPage() {
  const { access, timezone: tz } = useMe();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [day, setDay] = useState(() => todayInTz(tz));
  const [exported, setExported] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const exportAction = useAction();
  const teams = useApi(access.managesTeams ? 'teams' : null, (signal) => rd.teams.list(signal));
  const pending = useApi(access.managesTeams ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const week = startOfWeek(day);
  const range = daysRange(week, 7, tz);
  const sortedTeams = [...(teams.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const current = sortedTeams.find((t) => t.id === teamId) ?? sortedTeams[0];
  const report = useApi(current ? `team|${current.id}|${range.from}|${tz}|${projectId ?? ''}` : null, (signal) =>
    rd.teams.report(current!.id, { from: range.from, to: range.to }, tz, signal, projectId),
  );

  if (!access.managesTeams) return <NoAccess what="Team reports are for team managers." />;
  if (teams.error) return <ErrorState error={teams.error} onRetry={teams.reload} />;
  if (!teams.data) return <Loading label="Loading your teams" />;
  if (!current) return <Empty title="You don't manage any teams yet" />;

  const doExport = async () => {
    setExported(false);
    const r = await exportAction.run(() =>
      rd.exports.create({ kind: 'sessions', from: range.from, to: range.to, team_id: current.id }),
    );
    if (r) setExported(true);
  };

  return (
    <>
      <PageHeader
        eyebrow={`Team manager · ${plural(current.member_count, 'member')}`}
        title={`Team · ${current.name}`}
        description="Time and computer activity for the people you manage — the same numbers they see on their own pages."
        actions={
          <>
            {sortedTeams.length > 1 ? (
              <InlineSelect label="Team" value={current.id} onChange={(e) => setTeamId(e.target.value)}>
                {sortedTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </InlineSelect>
            ) : null}
            <InlineSelect label="Project" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
              <option value="">All projects</option>
              {projectOptions(report.data, projectId).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </InlineSelect>
            <DateSwitcher
              date={day}
              onDate={setDay}
              tz={tz}
              step={7}
              unit="week"
              label={`${week === startOfWeek(todayInTz(tz)) ? 'This week · ' : ''}${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
            />
            <Button variant="primary" onClick={doExport} disabled={exportAction.busy}>
              {exportAction.busy ? 'Exporting…' : 'Export CSV →'}
            </Button>
          </>
        }
      />
      <ActionError error={exportAction.error} />
      {exported ? (
        <Banner role="status" title="Export queued" actions={<Link href="/exports">Open exports →</Link>}>
          The CSV for this week is being prepared. Creating it is recorded in the audit log.
        </Banner>
      ) : null}
      <Banner tag="NOTE">
        Sorted by name. Computer activity describes device input during measurable time — not performance, and never the
        only basis for a decision about someone.
      </Banner>

      {report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : !report.data ? (
        <Loading label="Loading the team report" />
      ) : (
        <>
          <div className="row">
            <Card title="Members" className={s.members}>
              <MembersTable report={report.data} week={week} />
            </Card>
            <Attention report={report.data} pending={pending.data ?? []} />
          </div>
          <StackedDailyChart title="Team hours by project, per day" daily={report.data.daily} tz={tz} />
        </>
      )}
    </>
  );
}

/** Projects that appear in the report (the filtered report only contains the selected one). */
function projectOptions(report: TeamReport | null | undefined, selected: string | null): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const d of report?.daily ?? []) for (const p of d.projects) if (p.project_id) seen.set(p.project_id, p.project_name);
  if (selected && !seen.has(selected)) seen.set(selected, 'Selected project');
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
