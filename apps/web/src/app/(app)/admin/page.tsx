'use client';

import Link from 'next/link';
import { TEAM_SUMMARY_MIN_PEOPLE, type AdminOverview, type SetupStep } from '@rd/contracts';
import { Tiles } from '@/components/workspace/Tiles';
import s from '@/components/workspace/workspace.module.css';
import { Empty, Resource } from '@/components/ui/DataState';
import { Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { t, tPlural } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { addDays, formatDayMonth, formatDateTime } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { setupCopy, setupProgress, weekDelta } from '@/lib/workspaces';
import { NoAccess } from '../NoAccess';

function Checklist({ steps }: { steps: readonly SetupStep[] }) {
  const p = setupProgress(steps);
  return (
    <Card title={t('mgr.home.getSetUp')} subtitle={t('mgr.home.doneOf', { done: p.done, total: p.total })}>
      <div className={s.progress} role="progressbar" aria-label={t('mgr.home.progress')} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
        <div className={s.progressBar} style={{ width: `${(p.done / Math.max(1, p.total)) * 100}%` }} />
      </div>
      <ol className={s.steps}>
        {steps.map((step, i) => {
          const c = setupCopy(step.key);
          return (
            <li key={step.key} className={s.step}>
              <span className={step.done ? s.markDone : s.mark} aria-hidden="true">
                {step.done ? '✓' : i + 1}
              </span>
              <span className={s.stepText}>
                <span className={step.done ? s.stepDone : s.stepTitle}>
                  {c.title}
                  <span className="visually-hidden">{step.done ? t('mgr.home.stepDone') : t('mgr.home.stepToDo')}</span>
                </span>
                {!step.done ? <span className="small secondary">{c.body}</span> : null}
              </span>
              {!step.done ? (
                <Link href={c.href} className={s.stepGo}>
                  {c.action} →
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function OrgWeek({ week }: { week: AdminOverview['week'] }) {
  return (
    <Card
      title={t('mgr.home.weekTitle')}
      subtitle={t('mgr.home.weekSub', { from: formatDayMonth(week.week), to: formatDayMonth(addDays(week.week, 6)) })}
    >
      <Tiles
        label={t('mgr.home.orgHours')}
        tiles={[
          { label: t('mgr.home.trackedSoFar'), value: formatDuration(week.tracked_seconds), sub: weekDelta(week.tracked_seconds, week.previous_week_seconds) },
          { label: t('mgr.home.peopleTracking'), value: week.people_tracked, sub: t('mgr.home.recordedThisWeek') },
        ]}
      />
      {week.teams.length === 0 ? (
        <Empty title={t('mgr.home.noTeams')}>{t('mgr.home.noTeamsBody')}</Empty>
      ) : (
        <TableBox label={t('mgr.home.byTeam')}>
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">{t('nav.team')}</th>
                <th scope="col" className={numClass}>
                  {t('nav.people')}
                </th>
                <th scope="col" className={numClass}>
                  {t('mgr.home.trackedThisWeek')}
                </th>
              </tr>
            </thead>
            <tbody>
              {week.teams.map((tm) => (
                <tr key={tm.id}>
                  <th scope="row">{tm.name}</th>
                  <td className={numClass}>{tm.members}</td>
                  <td className={numClass}>
                    {tm.tracked_seconds === null ? (
                      <span className="small muted">{t('mgr.home.fewerThan', { n: TEAM_SUMMARY_MIN_PEOPLE })}</span>
                    ) : (
                      formatDuration(tm.tracked_seconds)
                    )}
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

/** Org admin home (G16, G20): what to set up, what needs attention, and the organization at a glance. */
export default function AdminHome() {
  const { access, me, timezone: tz } = useMe();
  const overview = useApi(access.isAdmin ? 'admin:overview' : null, (signal) => rd.admin.overview(signal));
  const sub = useApi(access.isAdmin ? 'billing:subscription' : null, (signal) => rd.billing.subscription(signal));
  const inbox = useApi(access.isAdmin ? 'nav:inbox-counts' : null, (signal) => rd.approvals.counts(signal));
  if (!access.isAdmin) return <NoAccess what={t('mgr.home.noAccess')} />;

  return (
    <>
      <PageHeader eyebrow={t('mgr.home.eyebrow')} title={t('mgr.home.title')} description={t('mgr.home.description', { org: me.organization.name })} />
      <Resource {...overview} label={t('mgr.home.loading')}>
        {(o) => {
          const sd = sub.data;
          const seats = sd ? t('mgr.home.seats', { used: sd.billable_seats, total: sd.seats }) : '—';
          const trial =
            sd?.status === 'trialing' && sd.trial_ends_at ? t('mgr.home.trialEnds', { when: formatDateTime(sd.trial_ends_at, tz) }) : sd ? t('mgr.home.plan', { plan: sd.plan_name }) : '';
          const waiting = inbox.data?.total ?? 0;
          return (
            <>
              {/* Gone once the required steps are done; optional ones never hold it open. */}
              {setupProgress(o.setup).complete ? null : <Checklist steps={o.setup} />}
              <Tiles
                label={t('mgr.home.needsAttention')}
                tiles={[
                  { label: t('mgr.home.waiting'), value: waiting, sub: waiting ? t('mgr.home.toReview') : t('mgr.home.nothingToReview'), href: '/approvals', alert: waiting > 0 },
                  {
                    label: t('mgr.home.noManager'),
                    value: o.people.without_reviewer,
                    sub: o.people.without_reviewer ? tPlural(o.people.without_reviewer, 'mgr.home.toYouOne', 'mgr.home.toYouOther') : t('mgr.home.everyoneReviewer'),
                    href: '/admin/teams',
                  },
                  {
                    label: t('mgr.home.computersToCheck'),
                    value: o.devices.stale + o.devices.permission_issues,
                    sub: t('mgr.home.computersSub', { stale: o.devices.stale, perm: o.devices.permission_issues }),
                    href: '/admin/devices',
                    alert: o.devices.stale + o.devices.permission_issues > 0,
                  },
                  { label: t('mgr.home.seatsInUse'), value: seats, sub: trial, href: '/admin/billing' },
                ]}
              />
              <Tiles
                label={t('mgr.home.peopleAndComputers')}
                tiles={[
                  {
                    label: t('nav.people'),
                    value: o.people.active,
                    sub: t('mgr.home.peopleSub', { invited: o.people.invited, off: o.people.tracking_off }),
                    href: '/admin/users',
                  },
                  {
                    label: t('mgr.home.computersConnected'),
                    value: o.devices.active,
                    sub: o.devices.never_synced ? t('mgr.home.neverSynced', { n: o.devices.never_synced }) : t('mgr.home.allSynced'),
                    href: '/admin/devices',
                  },
                ]}
              />
              <OrgWeek week={o.week} />
            </>
          );
        }}
      </Resource>
    </>
  );
}
