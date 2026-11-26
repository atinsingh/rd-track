'use client';

import Link from 'next/link';
import { useState } from 'react';
import { UTILIZATION_BAND_PERCENT, type CorrectionDTO, type MemberReportRow, type TeamOvertimeReport, type TeamReport } from '@rd/contracts';
import type { Range } from '@/lib/api';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { expectedStyles } from '@/components/insights/Expected';
import { StackedDailyChart } from '@/components/StackedDailyChart';
import { Stats } from '@/components/Stats';
import { StatusBadge, memberTimesheetHref } from '@/components/timesheet/TimesheetView';
import { ActivityInfo } from '@/components/ui/ActivityInfo';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { InlineSelect } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, durationOrDash, formatDuration, formatPercent, percentOrDash } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { limitsSummary, overtimeText, timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import { NoAccess } from '../NoAccess';
import s from './team.module.css';

/** A member's data notes in the reader's language. */
function notesOf(m: MemberReportRow): string[] {
  return m.permission_missing_minutes > 0
    ? [tPlural(m.permission_missing_minutes, 'mgr.team.noPermission.one', 'mgr.team.noPermission.other')]
    : [];
}

/** The "Everyone" choice in the team picker (org admins). */
const EVERYONE = 'everyone';

function memberHref(m: MemberReportRow, teamId: string | null, week: string): string {
  const q = new URLSearchParams({ ...(teamId ? { team: teamId } : {}), name: m.display_name, date: week });
  return `/team/${encodeURIComponent(m.user_id)}?${q.toString()}`;
}

function Attention({ report, pending }: { report: TeamReport; pending: CorrectionDTO[] }) {
  const ids = new Set(report.members.map((m) => m.user_id));
  const mine = pending.filter((c) => ids.has(c.user_id));
  const withNotes = [...report.members].sort(byName).filter((m) => notesOf(m).length > 0);
  const first = mine[0];
  return (
    <Card title={t('mgr.team.attention')} as="aside" className={s.attention}>
      {mine.length > 0 ? (
        <Link href="/approvals" className={s.attItem}>
          <span className={s.attTitle}>{tPlural(mine.length, 'mgr.team.toReview.one', 'mgr.team.toReview.other')}</span>
          {first ? (
            <span className={s.attBody}>
              {first.user_name} · {first.kind === 'manual_add' ? t('mgr.kind.manual') : first.kind === 'idle_reassign' ? t('mgr.kind.idle') : t('mgr.kind.edit')} · “{first.reason}”
            </span>
          ) : null}
        </Link>
      ) : (
        <div className={s.attItem}>
          <span className={s.attTitle}>{t('mgr.team.noCorrections')}</span>
          <span className={s.attBody}>{t('mgr.team.noCorrectionsBody')}</span>
        </div>
      )}
      {withNotes.length > 0 ? (
        <div className={`${s.attItem} ${s.attWarn}`}>
          <span className={s.attTitle}>{tPlural(withNotes.length, 'mgr.team.notesFor.one', 'mgr.team.notesFor.other')}</span>
          <span className={s.attBody}>
            {withNotes
              .slice(0, 3)
              .map((m) => `${m.display_name}: ${notesOf(m).join('; ')}`)
              .join(' · ')}
            {t('mgr.team.unmeasured')}
          </span>
        </div>
      ) : null}
      <div className={s.attItem}>
        <span className={s.attTitle}>{t('day.screenshots')}</span>
        <span className={s.attBody}>
          {report.visibility.screenshots
            ? t('mgr.team.shotsShared')
            : t('mgr.team.shotsNotShared')}
        </span>
      </div>
    </Card>
  );
}

function MembersTable({ report, teamId, week, overtime }: { report: TeamReport; teamId: string | null; week: string; overtime?: TeamOvertimeReport }) {
  const rows = [...report.members].sort(byName);
  const showActivity = report.visibility.activity;
  if (rows.length === 0) return <Empty title={t('mgr.team.noMembers')} />;
  return (
    <TableBox label={t('mgr.team.membersLabel')}>
      <table className={`${tableClass} ${s.membersTable}`} style={{ minWidth: 800 }}>
        <caption className="visually-hidden">{t('mgr.team.membersCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort="ascending">
              {t('mgr.col.nameSorted')}
            </th>
            <th scope="col" className={numClass} title={t('mgr.col.trackedHint')}>
              {t('mgr.col.tracked')}
            </th>
            {showActivity ? (
              <>
                <th scope="col" className={numClass}>
                  {t('mgr.col.active')}
                </th>
                <th scope="col" className={numClass}>
                  {t('mgr.col.idle')}
                </th>
                <th scope="col">
                  <span className={s.thActivity}>
                    {t('mgr.col.activity')} <ActivityInfo />
                  </span>
                </th>
              </>
            ) : null}
            <th scope="col" className={numClass}>
              {t('tiles.notMeasured')}
            </th>
            <th scope="col" className={numClass}>
              {t('session.manual')}
            </th>
            <th scope="col" className={numClass}>
              {t('mgr.col.days')}
            </th>
            {overtime ? (
              <>
                <th scope="col" className={numClass}>
                  {t('mgr.col.over')}
                </th>
                <th scope="col">{t('mgr.col.timesheet')}</th>
              </>
            ) : null}
            <th scope="col">{t('mgr.col.notes')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.user_id}>
              <td>
                <Link href={memberHref(m, teamId, week)} className={s.memberLink}>
                  {m.display_name}
                </Link>
              </td>
              <td className={numClass}>{formatDuration(m.tracked_seconds)}</td>
              {showActivity ? (
                <>
                  <td className={numClass}>{m.activity_percent === null ? '—' : formatDuration(m.active_seconds)}</td>
                  <td className={numClass}>{m.activity_percent === null ? '—' : formatDuration(m.idle_seconds)}</td>
                  <td>
                    {m.activity_percent === null ? (
                      <span className="mono muted">—</span>
                    ) : (
                      <span className={s.act}>
                        <span className={s.actNum}>{formatPercent(m.activity_percent)}</span>
                        <span className={s.actTrack} aria-hidden="true">
                          <span className={s.actFill} style={{ width: `${m.activity_percent}%` }} />
                        </span>
                      </span>
                    )}
                  </td>
                </>
              ) : null}
              <td className={numClass}>{durationOrDash(m.gap_seconds + m.paused_seconds)}</td>
              <td className={numClass}>{durationOrDash(m.manual_seconds)}</td>
              <td className={numClass}>{m.days_active}</td>
              {overtime ? <OvertimeCells row={overtime.members.find((o) => o.user_id === m.user_id)} member={m} teamId={report.team.id} week={week} /> : null}
              <td className="small secondary">{notesOf(m).join('; ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableBox>
  );
}

/** Aggregates only, for teams large enough that nobody can be singled out (RPT-07). */
function TeamInsightsCard({ teamId, range, tz, isAdmin }: { teamId: string; range: Range; tz: string; isAdmin: boolean }) {
  const insights = useApi(`team:insights|${teamId}|${range.from}|${tz}`, (signal) => rd.teams.insights(teamId, range, tz, signal));
  const e = insights.error;
  return (
    <Card title={t('mgr.ins.title')} subtitle={t('mgr.ins.subtitle')}>
      {e?.code === 'insufficient_group_size' ? (
        <Empty title={t('mgr.ins.small')}>{e.message}</Empty>
      ) : e?.status === 402 ? (
        <Empty title={t('mgr.ins.pro')}>
          {isAdmin ? <Link href="/admin/billing">{t('mgr.comparePlans')}</Link> : t('mgr.ins.askAdmin')}
        </Empty>
      ) : e ? (
        <ErrorState error={e} onRetry={insights.reload} />
      ) : !insights.data ? (
        <Loading label={t('mgr.ins.loading')} />
      ) : (
        <>
          <Stats
            items={[
              {
                label: t('ins.vsExpected'),
                value: percentOrDash(insights.data.utilization.percent),
                note: t('mgr.ins.perPerson', {
                  tracked: formatDuration(insights.data.utilization.tracked_seconds),
                  expected: formatDuration(insights.data.utilization.expected_seconds),
                }),
              },
              {
                label: t('mgr.ins.focus'),
                value: formatDuration(insights.data.per_person.focus_seconds),
                note: t('mgr.ins.ofTracked', { pct: percentOrDash(insights.data.focus_share_percent) }),
              },
              {
                label: t('mgr.ins.outside'),
                value: formatDuration(insights.data.per_person.after_hours_seconds),
                note: t('mgr.ins.ofPeople', { n: insights.data.people_with_after_hours, total: insights.data.member_count }),
              },
              {
                label: t('mgr.ins.longDay'),
                value: `${insights.data.people_with_long_days} / ${insights.data.member_count}`,
                note: t('mgr.ins.longDayNote'),
              },
            ]}
          />
          <p className={expectedStyles.counts}>
            <span>
              <span className={expectedStyles.under} aria-hidden="true" />
              {t('mgr.ins.under', { n: insights.data.utilization.under })}
            </span>
            <span>
              <span className={expectedStyles.about} aria-hidden="true" />
              {t('mgr.ins.about', { n: insights.data.utilization.about, band: UTILIZATION_BAND_PERCENT })}
            </span>
            <span>
              <span className={expectedStyles.over} aria-hidden="true" />
              {t('mgr.ins.over', { n: insights.data.utilization.over })}
            </span>
            {insights.data.utilization.none ? <span>{t('mgr.ins.none', { n: insights.data.utilization.none })}</span> : null}
            <span className="muted">{t('mgr.ins.countsOnly')}</span>
          </p>
        </>
      )}
    </Card>
  );
}

/** Overtime and timesheet status for one member: neutral ink, never a score. */
function OvertimeCells({ row, member, teamId, week }: { row: TeamOvertimeReport['members'][number] | undefined; member: MemberReportRow; teamId: string; week: string }) {
  const w = row?.weeks[0];
  return (
    <>
      <td className={numClass} title={row ? limitsSummary(row.limits) : undefined}>
        {row ? overtimeText(row.overtime_seconds) : '—'}
      </td>
      <td>
        {w ? (
          <Link href={memberTimesheetHref(member.user_id, week, { team: teamId, name: member.display_name })} className={s.memberLink}>
            <StatusBadge status={w.status} />
          </Link>
        ) : (
          '—'
        )}
      </td>
    </>
  );
}

export default function TeamPage() {
  const { me, access, timezone: tz } = useMe();
  const allowed = access.managesTeams || access.isAdmin;
  const [teamId, setTeamId] = useState<string | null>(null);
  const [day, setDay] = useState(() => todayInTz(tz));
  const [exported, setExported] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const exportAction = useAction();
  const teams = useApi(allowed ? 'teams' : null, (signal) => rd.teams.list(signal));
  const pending = useApi(allowed ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const week = startOfWeek(day);
  const range = daysRange(week, 7, tz);
  const sortedTeams = [...(teams.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  // Org admins start on everyone: people in no team are only there.
  const everyone = access.isAdmin && (teamId ?? EVERYONE) === EVERYONE;
  const current = everyone ? undefined : (sortedTeams.find((t) => t.id === teamId) ?? sortedTeams[0]);
  // Overtime and insights are for the team's own managers.
  const manages = !!current && me.managed_team_ids.includes(current.id);
  const reportKey = everyone ? `org|${range.from}|${tz}|${projectId ?? ''}` : current ? `team|${current.id}|${range.from}|${tz}|${projectId ?? ''}` : null;
  const report = useApi(teams.data ? reportKey : null, (signal) =>
    everyone
      ? rd.teams.everyone({ from: range.from, to: range.to }, tz, signal, projectId)
      : rd.teams.report(current!.id, { from: range.from, to: range.to }, tz, signal, projectId),
  );

  const overtime = useApi(
    current && manages && access.entitlements.includes('timesheets') ? `team:overtime|${current.id}|${week}` : null,
    (signal) => timesheetsApi.teamOvertime(current!.id, week, addDays(week, 6), signal),
  );

  if (!allowed) return <NoAccess what={t('mgr.team.noAccess')} />;
  if (teams.error) return <ErrorState error={teams.error} onRetry={teams.reload} />;
  if (!teams.data) return <Loading label={t('mgr.team.loadingTeams')} />;
  if (!current && !everyone) return <Empty title={t('mgr.team.noTeams')} />;

  const count = report.data?.team.member_count ?? current?.member_count ?? 0;
  const doExport = async () => {
    if (!current) return;
    setExported(false);
    const r = await exportAction.run(() =>
      rd.exports.create({ kind: 'sessions', from: range.from, to: range.to, team_id: current.id }),
    );
    if (r) setExported(true);
  };

  return (
    <>
      <PageHeader
        eyebrow={manages ? tPlural(count, 'mgr.team.eyebrow.one', 'mgr.team.eyebrow.other') : tPlural(count, 'mgr.team.eyebrowAdmin.one', 'mgr.team.eyebrowAdmin.other')}
        title={current ? t('mgr.team.title', { name: current.name }) : t('mgr.team.everyone')}
        description={t('mgr.team.description')}
        actions={
          <>
            {sortedTeams.length > 1 || access.isAdmin ? (
              <InlineSelect label={t('nav.team')} value={current?.id ?? EVERYONE} onChange={(e) => setTeamId(e.target.value)}>
                {access.isAdmin ? <option value={EVERYONE}>{t('mgr.team.everyone')}</option> : null}
                {sortedTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </InlineSelect>
            ) : null}
            <InlineSelect label={t('mgr.project')} value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
              <option value="">{t('mgr.allProjects')}</option>
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
              label={`${week === startOfWeek(todayInTz(tz)) ? t('ts.thisWeekPrefix') : ''}${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
            />
            {current ? (
              <Button variant="primary" onClick={doExport} disabled={exportAction.busy}>
                {exportAction.busy ? t('mgr.exporting') : t('mgr.exportCsv')}
              </Button>
            ) : null}
          </>
        }
      />
      <ActionError error={exportAction.error} />
      {exported ? (
        <Banner role="status" title={t('mgr.team.exportQueued')} actions={<Link href="/exports">{t('mgr.team.openExports')}</Link>}>
          {t('mgr.team.exportBody')}
        </Banner>
      ) : null}
      <Banner tag="NOTE">
        {t('mgr.team.note')}
      </Banner>

      {report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : !report.data ? (
        <Loading label={t('mgr.team.loadingReport')} />
      ) : (
        <>
          <div className="row">
            <Card title={t('mgr.team.members')} className={s.members}>
              <MembersTable report={report.data} teamId={current?.id ?? null} week={week} overtime={overtime.data} />
            </Card>
            <Attention report={report.data} pending={pending.data ?? []} />
          </div>
          <StackedDailyChart title={t('mgr.team.chartTitle')} daily={report.data.daily} tz={tz} />
          {current && manages ? (
            <TeamInsightsCard teamId={current.id} range={{ from: range.from, to: range.to }} tz={tz} isAdmin={access.isAdmin} />
          ) : null}
        </>
      )}
    </>
  );
}

/** Projects that appear in the report (the filtered report only contains the selected one). */
function projectOptions(report: TeamReport | null | undefined, selected: string | null): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const d of report?.daily ?? []) for (const p of d.projects) if (p.project_id) seen.set(p.project_id, p.project_name);
  if (selected && !seen.has(selected)) seen.set(selected, t('mgr.team.selectedProject'));
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
