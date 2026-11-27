'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { UTILIZATION_BAND_PERCENT, type CorrectionDTO, type MemberReportRow, type TeamOvertimeReport, type TeamReport, type ConsentStatus } from '@rd/contracts';
import type { Range } from '@/lib/api';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { expectedStyles } from '@/components/insights/Expected';
import { AskAgain, ConsentBadge, ConsentNotice } from '@/components/consent/Consent';
import { StackedDailyChart } from '@/components/StackedDailyChart';
import { Stats } from '@/components/Stats';
import { StatusBadge, memberTimesheetHref } from '@/components/timesheet/TimesheetView';
import { ActivityInfo } from '@/components/ui/ActivityInfo';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { InlineSelect, Segmented, inputClass } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, durationOrDash, formatDuration, formatPercent, formatPlace, percentOrDash } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayLabel, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { limitsSummary, overtimeText, timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import type { MessageKey } from '@/lib/messages/en';
import { NoAccess } from '../NoAccess';
import s from './team.module.css';

type LiveStatus = 'tracking' | 'paused' | 'idle' | 'offline';
/** What the report adds to each row beyond the shared contract: right-now status and the period's screenshot count. */
type MemberRow = MemberReportRow & { status?: LiveStatus; screenshot_count?: number | null; consent?: ConsentStatus };
const STATUSES: LiveStatus[] = ['tracking', 'paused', 'idle', 'offline'];
const STATUS_LABEL: Record<LiveStatus, MessageKey> = {
  tracking: 'mgr.status.tracking',
  paused: 'mgr.status.paused',
  idle: 'mgr.status.idle',
  offline: 'mgr.status.offline',
};

type Mode = 'day' | 'week' | 'custom';
/** The API's longest report range. */
const MAX_DAYS = 93;
const dayCount = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

/** A member's data notes in the reader's language. */
function notesOf(m: MemberReportRow): string[] {
  return m.permission_missing_minutes > 0 ? [tPlural(m.permission_missing_minutes, 'mgr.team.noPermission.one', 'mgr.team.noPermission.other')] : [];
}

/** The table's notes add unmeasured time (paused, or the computer not reporting); a pause is no warning. */
function rowNotes(m: MemberReportRow): string {
  const unmeasured = m.gap_seconds + m.paused_seconds;
  return [...notesOf(m), ...(unmeasured > 0 ? [t('mgr.team.notMeasured', { d: formatDuration(unmeasured) })] : [])].join('; ');
}

/** The "Everyone" choice in the team picker (org admins). */
const EVERYONE = 'everyone';

function memberHref(m: MemberReportRow, teamId: string | null, date: string, hash = ''): string {
  const q = new URLSearchParams({ ...(teamId ? { team: teamId } : {}), name: m.display_name, date });
  return `/team/${encodeURIComponent(m.user_id)}?${q.toString()}${hash}`;
}

/** Status as a shape and a word, never colour alone. */
function StatusLabel({ status }: { status: LiveStatus }) {
  return (
    <span className={s.status}>
      <span className={`${s.dot} ${s[status]}`} aria-hidden="true" />
      {t(STATUS_LABEL[status])}
    </span>
  );
}

function StatusSummary({ rows, onRefresh, busy }: { rows: MemberRow[]; onRefresh: () => void; busy: boolean }) {
  const counts = new Map<LiveStatus, number>();
  for (const m of rows) if (m.status) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
  return (
    <div className={s.summary}>
      <ul className={s.summaryList} aria-label={t('mgr.status.now')}>
        {STATUSES.map((st) => (
          <li key={st}>
            <StatusLabel status={st} /> <span className="mono">{counts.get(st) ?? 0}</span>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="quiet" onClick={onRefresh} disabled={busy}>
        {t('mgr.status.refresh')}
      </Button>
    </div>
  );
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

function MembersTable({
  report,
  teamId,
  date,
  multiDay,
  overtime,
  week,
}: {
  report: TeamReport;
  teamId: string | null;
  /** the day a person's link opens */
  date: string;
  multiDay: boolean;
  overtime?: TeamOvertimeReport;
  week: string;
}) {
  const rows: MemberRow[] = [...report.members].sort(byName);
  const showActivity = report.visibility.activity;
  const showShots = report.visibility.screenshots;
  const showLocation = rows.some((m) => m.location || m.usual_location);
  if (rows.length === 0) return <Empty title={t('mgr.team.noMembers')} />;
  return (
    <TableBox label={t('mgr.team.membersLabel')}>
      <table className={`${tableClass} ${s.membersTable}`} style={{ minWidth: 1200 }}>
        <caption className="visually-hidden">{t('mgr.team.membersCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort="ascending">
              {t('mgr.col.nameSorted')}
            </th>
            <th scope="col" title={t('mgr.col.nowHint')}>
              {t('mgr.status.now')}
            </th>
            <th scope="col" className={numClass} title={t('mgr.col.workedHint')}>
              {t('mgr.col.worked')}
            </th>
            {showActivity ? (
              <>
                <th scope="col" className={numClass}>
                  {t('mgr.col.active')}
                </th>
                <th scope="col" className={numClass}>
                  {t('mgr.col.idle')}
                </th>
                <th scope="col" className={numClass}>
                  <span className={s.thActivity}>
                    {t('mgr.col.activity')} <ActivityInfo />
                  </span>
                </th>
              </>
            ) : null}
            <th scope="col" className={numClass} title={t('mgr.col.quitsHint')}>
              {t('mgr.col.quits')}
            </th>
            <th scope="col" className={numClass} title={t('mgr.col.awayHint')}>
              {t('mgr.col.away')}
            </th>
            <th scope="col" className={numClass} title={t('mgr.col.underHint')}>
              {t('mgr.col.under')}
            </th>
            <th scope="col" className={numClass}>
              {t('session.manual')}
            </th>
            <th scope="col" className={numClass} title={t('mgr.col.totalHint')}>
              {t('mgr.col.total')}
            </th>
            {multiDay ? (
              <th scope="col" className={numClass}>
                {t('mgr.col.days')}
              </th>
            ) : null}
            {showShots ? (
              <th scope="col" className={numClass} title={t('mgr.col.shotsHint', { date: formatDayLabel(date) })}>
                {t('day.screenshots')}
              </th>
            ) : null}
            {overtime ? (
              <>
                <th scope="col" className={numClass}>
                  {t('mgr.col.over')}
                </th>
                <th scope="col">{t('mgr.col.timesheet')}</th>
              </>
            ) : null}
            {showLocation ? <th scope="col">{t('mgr.col.location')}</th> : null}
            <th scope="col">{t('mgr.col.notes')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.user_id}>
              <td>
                <Link href={memberHref(m, teamId, date)} className={s.memberLink}>
                  {m.display_name}
                </Link>
              </td>
              {/* Without an accepted monitoring agreement the app tracks nothing: say so, so an admin can follow up. */}
              <td>
                {m.consent && m.consent !== 'accepted' ? (
                  <span className="row">
                    <ConsentBadge status={m.consent} />
                    <AskAgain userId={m.user_id} />
                  </span>
                ) : m.status ? (
                  <StatusLabel status={m.status} />
                ) : (
                  '—'
                )}
              </td>
              <td className={numClass}>{formatDuration(m.tracked_seconds)}</td>
              {showActivity ? (
                <>
                  <td className={numClass}>{m.activity_percent === null ? '—' : formatDuration(m.active_seconds)}</td>
                  <td className={numClass}>{m.activity_percent === null ? '—' : formatDuration(m.idle_seconds)}</td>
                  <td className={numClass}>
                    {m.activity_percent === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={s.act}>
                        <span className={s.actTrack} aria-hidden="true">
                          <span className={s.actFill} style={{ width: `${m.activity_percent}%` }} />
                        </span>
                        <span className={s.actNum}>{formatPercent(m.activity_percent)}</span>
                      </span>
                    )}
                  </td>
                </>
              ) : null}
              <td className={`${numClass} ${m.quits_during_hours > 0 ? s.warn : s.zero}`}>{m.quits_during_hours}</td>
              <td className={`${numClass} ${m.quit_away_seconds > 0 ? s.warn : s.zero}`}>{formatDuration(m.quit_away_seconds)}</td>
              <td className={`${numClass} ${m.days_under_target > 0 ? s.warn : s.zero}`}>
                {t('mgr.col.underDays', { n: m.days_under_target, m: m.work_days })}
              </td>
              <td className={numClass}>{durationOrDash(m.manual_seconds)}</td>
              <td className={numClass}>{formatDuration(m.tracked_seconds + m.manual_seconds)}</td>
              {multiDay ? <td className={numClass}>{m.days_active}</td> : null}
              {showShots ? (
                <td className={numClass}>
                  {m.screenshot_count == null ? (
                    '—'
                  ) : m.screenshot_count === 0 ? (
                    '0'
                  ) : (
                    <Link
                      href={memberHref(m, teamId, date, '#screenshots')}
                      className={s.memberLink}
                      aria-label={t('mgr.shots.open', { n: m.screenshot_count, name: m.display_name, date: formatDayLabel(date) })}
                    >
                      {m.screenshot_count}
                    </Link>
                  )}
                </td>
              ) : null}
              {overtime ? <OvertimeCells row={overtime.members.find((o) => o.user_id === m.user_id)} member={m} teamId={report.team.id} week={week} /> : null}
              {showLocation ? (
                <td
                  className={m.location_changes > 0 ? s.warn : undefined}
                  title={t('mgr.col.locationHint', { usual: formatPlace(m.usual_location), n: m.location_changes })}
                >
                  {formatPlace(m.location)}
                </td>
              ) : null}
              <td className="small secondary">{rowNotes(m) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableBox>
  );
}

/** Today, a week, or any span of days up to the API's limit. */
function RangePicker({
  mode,
  onMode,
  day,
  onDay,
  custom,
  onCustom,
  tz,
  error,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  day: string;
  onDay: (d: string) => void;
  custom: { from: string; to: string };
  onCustom: (c: { from: string; to: string }) => void;
  tz: string;
  error: string | null;
}) {
  const id = useId();
  const today = todayInTz(tz);
  const week = startOfWeek(day);
  return (
    <div className={s.range}>
      <Segmented
        legend={t('mgr.range.label')}
        name={`${id}-mode`}
        value={mode}
        onChange={onMode}
        options={[
          { value: 'day', label: t('mgr.range.day') },
          { value: 'week', label: t('mgr.range.week') },
          { value: 'custom', label: t('mgr.range.custom') },
        ]}
      />
      {mode === 'day' ? (
        <DateSwitcher date={day} onDate={onDay} tz={tz} max={today} label={day === today ? t('mgr.range.today') : formatDayLabel(day)} />
      ) : mode === 'week' ? (
        <DateSwitcher
          date={day}
          onDate={onDay}
          tz={tz}
          step={7}
          unit="week"
          max={today}
          label={`${week === startOfWeek(today) ? t('ts.thisWeekPrefix') : ''}${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
        />
      ) : (
        <span className={s.customRange}>
          <label htmlFor={`${id}-from`}>{t('mgr.range.from')}</label>
          <input
            id={`${id}-from`}
            type="date"
            className={inputClass}
            value={custom.from}
            max={custom.to}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => e.target.value && onCustom({ ...custom, from: e.target.value })}
          />
          <label htmlFor={`${id}-to`}>{t('mgr.range.to')}</label>
          <input
            id={`${id}-to`}
            type="date"
            className={inputClass}
            value={custom.to}
            min={custom.from}
            max={today}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => e.target.value && onCustom({ ...custom, to: e.target.value })}
          />
          {error ? (
            <span id={`${id}-err`} role="alert" className={s.rangeError}>
              {error}
            </span>
          ) : null}
        </span>
      )}
    </div>
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
  const today = todayInTz(tz);
  // Opens on today: who is working right now and what they did so far.
  const [mode, setMode] = useState<Mode>('day');
  const [day, setDay] = useState(today);
  const [custom, setCustom] = useState(() => ({ from: addDays(today, -6), to: today }));
  const [exported, setExported] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const exportAction = useAction();
  const teams = useApi(allowed ? 'teams' : null, (signal) => rd.teams.list(signal));
  const pending = useApi(allowed ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const week = startOfWeek(day);
  const span =
    mode === 'day' ? { start: day, days: 1 } : mode === 'week' ? { start: week, days: 7 } : { start: custom.from, days: dayCount(custom.from, custom.to) };
  const rangeError = mode !== 'custom' ? null : span.days < 1 ? t('mgr.range.order') : span.days > MAX_DAYS ? t('mgr.range.tooLong', { n: MAX_DAYS }) : null;
  const range = daysRange(span.start, Math.max(1, span.days), tz);
  // A person's page shows one day: the chosen one, or the period's last day so far.
  const lastDay = addDays(span.start, span.days - 1);
  const focusDay = mode === 'day' ? day : lastDay < today ? lastDay : today;
  const sortedTeams = [...(teams.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  // Org admins start on everyone: people in no team are only there.
  const everyone = access.isAdmin && (teamId ?? EVERYONE) === EVERYONE;
  const current = everyone ? undefined : (sortedTeams.find((t) => t.id === teamId) ?? sortedTeams[0]);
  // Overtime and insights are for the team's own managers.
  const manages = !!current && me.managed_team_ids.includes(current.id);
  const reportKey = rangeError
    ? null
    : everyone
      ? `org|${range.from}|${range.to}|${tz}|${projectId ?? ''}`
      : current
        ? `team|${current.id}|${range.from}|${range.to}|${tz}|${projectId ?? ''}`
        : null;
  const report = useApi(teams.data ? reportKey : null, (signal) =>
    everyone
      ? rd.teams.everyone({ from: range.from, to: range.to }, tz, signal, projectId)
      : rd.teams.report(current!.id, { from: range.from, to: range.to }, tz, signal, projectId),
  );

  // Overtime and timesheets are weekly, so they show with the week view.
  const overtime = useApi(
    mode === 'week' && current && manages && access.entitlements.includes('timesheets') ? `team:overtime|${current.id}|${week}` : null,
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
            {current ? (
              <Button variant="primary" onClick={doExport} disabled={exportAction.busy || !!rangeError}>
                {exportAction.busy ? t('mgr.exporting') : t('mgr.exportCsv')}
              </Button>
            ) : null}
          </>
        }
      />
      <RangePicker mode={mode} onMode={setMode} day={day} onDay={setDay} custom={custom} onCustom={setCustom} tz={tz} error={rangeError} />
      <ActionError error={exportAction.error} />
      {exported ? (
        <Banner role="status" title={t('mgr.team.exportQueued')} actions={<Link href="/exports">{t('mgr.team.openExports')}</Link>}>
          {t('mgr.team.exportBody')}
        </Banner>
      ) : null}

      {rangeError ? null : report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : !report.data ? (
        <Loading label={t('mgr.team.loadingReport')} />
      ) : (
        <>
          <div className="row">
            <Card
              title={t('mgr.team.members')}
              className={s.members}
              actions={<StatusSummary rows={report.data.members} onRefresh={report.reload} busy={report.loading} />}
            >
              <MembersTable report={report.data} teamId={current?.id ?? null} date={focusDay} multiDay={span.days > 1} overtime={overtime.data} week={week} />
            </Card>
            <Attention report={report.data} pending={pending.data ?? []} />
          </div>
          <ConsentNotice members={report.data.members as MemberRow[]} />
          <Banner tag="NOTE">{t('mgr.team.note')}</Banner>
          {span.days > 1 ? <StackedDailyChart title={t('mgr.team.chartTitle')} daily={report.data.daily} tz={tz} /> : null}
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
