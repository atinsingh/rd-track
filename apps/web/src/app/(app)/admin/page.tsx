'use client';

import Link from 'next/link';
import { TEAM_SUMMARY_MIN_PEOPLE, type AdminOverview, type SetupStep } from '@rd/contracts';
import { Tiles } from '@/components/workspace/Tiles';
import s from '@/components/workspace/workspace.module.css';
import { Empty, Resource } from '@/components/ui/DataState';
import { Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatDuration, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, formatDayMonth, formatDateTime } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { SETUP_COPY, setupProgress, weekDelta } from '@/lib/workspaces';
import { NoAccess } from '../NoAccess';

function Checklist({ steps }: { steps: readonly SetupStep[] }) {
  const p = setupProgress(steps);
  return (
    <Card title="Get set up" subtitle={`${p.done} of ${p.total} done`}>
      <div className={s.progress} role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
        <div className={s.progressBar} style={{ width: `${(p.done / Math.max(1, p.total)) * 100}%` }} />
      </div>
      <ol className={s.steps}>
        {steps.map((step, i) => {
          const c = SETUP_COPY[step.key];
          return (
            <li key={step.key} className={s.step}>
              <span className={step.done ? s.markDone : s.mark} aria-hidden="true">
                {step.done ? '✓' : i + 1}
              </span>
              <span className={s.stepText}>
                <span className={step.done ? s.stepDone : s.stepTitle}>
                  {c.title}
                  <span className="visually-hidden">{step.done ? ' (done)' : ' (to do)'}</span>
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
      title="This week across the organization"
      subtitle={`Week of ${formatDayMonth(week.week)} – ${formatDayMonth(addDays(week.week, 6))}. Hours only; never activity levels.`}
    >
      <Tiles
        label="Organization hours"
        tiles={[
          { label: 'Tracked so far', value: formatDuration(week.tracked_seconds), sub: weekDelta(week.tracked_seconds, week.previous_week_seconds) },
          { label: 'People tracking', value: week.people_tracked, sub: 'Recorded any time this week' },
        ]}
      />
      {week.teams.length === 0 ? (
        <Empty title="No teams yet">Create teams to see hours by team.</Empty>
      ) : (
        <TableBox label="Hours by team">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col" className={numClass}>
                  People
                </th>
                <th scope="col" className={numClass}>
                  Tracked this week
                </th>
              </tr>
            </thead>
            <tbody>
              {week.teams.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td className={numClass}>{t.members}</td>
                  <td className={numClass}>
                    {t.tracked_seconds === null ? (
                      <span className="small muted">Fewer than {TEAM_SUMMARY_MIN_PEOPLE} people</span>
                    ) : (
                      formatDuration(t.tracked_seconds)
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
  if (!access.isAdmin) return <NoAccess what="Setup and health is for org admins." />;

  return (
    <>
      <PageHeader eyebrow="Org admin · Home" title="Setup and health" description={`${me.organization.name}: what to set up, what needs you, and how the week is going.`} />
      <Resource {...overview} label="Loading the overview">
        {(o) => {
          const sd = sub.data;
          const seats = sd ? `${sd.billable_seats} of ${sd.seats}` : '—';
          const trial = sd?.status === 'trialing' && sd.trial_ends_at ? `Trial ends ${formatDateTime(sd.trial_ends_at, tz)}` : sd ? `${sd.plan_name} plan` : '';
          const waiting = inbox.data?.total ?? 0;
          return (
            <>
              {/* Gone once the required steps are done; optional ones never hold it open. */}
              {setupProgress(o.setup).complete ? null : <Checklist steps={o.setup} />}
              <Tiles
                label="Needs attention"
                tiles={[
                  { label: 'Waiting for you', value: waiting, sub: waiting ? 'Requests to review' : 'Nothing to review', href: '/approvals', alert: waiting > 0 },
                  {
                    label: 'No team manager',
                    value: o.people.without_reviewer,
                    sub: o.people.without_reviewer ? `${plural(o.people.without_reviewer, 'person', 'people')} whose requests come to you` : 'Everyone has a reviewer',
                    href: '/admin/teams',
                  },
                  {
                    label: 'Computers to check',
                    value: o.devices.stale + o.devices.permission_issues,
                    sub: `${o.devices.stale} not synced for 3+ working days · ${o.devices.permission_issues} missing a permission`,
                    href: '/admin/devices',
                    alert: o.devices.stale + o.devices.permission_issues > 0,
                  },
                  { label: 'Seats in use', value: seats, sub: trial, href: '/admin/billing' },
                ]}
              />
              <Tiles
                label="People and computers"
                tiles={[
                  { label: 'People', value: o.people.active, sub: `${o.people.invited} invited, not yet joined · ${o.people.tracking_off} not tracking`, href: '/admin/users' },
                  { label: 'Computers connected', value: o.devices.active, sub: o.devices.never_synced ? `${o.devices.never_synced} never synced` : 'All have synced', href: '/admin/devices' },
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
