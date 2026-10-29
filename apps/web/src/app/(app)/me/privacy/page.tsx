'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  NEVER_COLLECTED,
  describeCollection,
  type AuditEventDTO,
  type CollectionItem,
  type ErasureRequestDTO,
  type MyPolicyResponse,
  type NotificationDTO,
} from '@rd/contracts';
import { DataExports } from '@/components/DataExports';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { announceNotificationsChanged } from '@/lib/events';
import { humanize } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi, type ApiResource } from '@/lib/useApi';
import s from './privacy.module.css';

interface Row extends CollectionItem {
  scope?: string;
}

/** Base items, plus per-project lines where a project's policy differs (e.g. screenshots on Client A). */
function collectionRows(policy: MyPolicyResponse): Row[] {
  const base = describeCollection(policy.base.settings);
  const rows: Row[] = [...base];
  for (const p of policy.projects) {
    const items = describeCollection(p.settings);
    for (const it of items) {
      const b = base.find((x) => x.key === it.key);
      if (b && b.collected !== it.collected) {
        const at = rows.findIndex((r) => r.key === it.key);
        rows.splice(at + 1, 0, { ...it, key: `${it.key}@${p.project_id}`, text: `${it.text} on project ${p.project_name}`, scope: p.project_name });
      }
    }
  }
  return rows;
}

const RELATION: Record<string, string> = { team_manager: 'Team manager', project_manager: 'Project manager' };

// Action names as written by the API's audit log (apps/api/src/modules/**).
const ACTION_TEXT: Record<string, string> = {
  'screenshot.view': 'Opened one of your screenshots',
  'pay_rate.view': 'Viewed your pay rate',
  'payroll_adjustment.view': 'Viewed your bonuses and deductions',
  'expense.receipt_view': 'Opened your expense receipt',
  'client_portal.view_hours': 'Saw your hours on their project, in the client portal',
  'payroll_adjustment.create': 'Added a bonus, deduction or reimbursement for you',
  'payroll_adjustment.end': 'Ended a recurring bonus or deduction of yours',
  'payroll_adjustment.delete': 'Removed a bonus, deduction or reimbursement of yours',
  'pay_rate.create': 'Set a new pay rate for you',
  'pay_rate.delete': 'Cancelled a scheduled change to your pay rate',
  'bill_rate.create': 'Set a client bill rate for your time',
  'screenshot.list': 'Listed your screenshots',
  'screenshot.deleted': 'One of your screenshots was deleted',
  'activity.view': 'Viewed your computer activity',
  'apps.view': 'Viewed your app usage',
  'time.view': 'Viewed your sessions',
  'export.create': 'Exported data that includes you',
  'time_correction.approve': 'Approved your correction',
  'time_correction.reject': 'Rejected your correction',
  'timesheet.view': 'Viewed your timesheet',
  'timesheet.approve': 'Approved your timesheet',
  'timesheet.reject': 'Sent back your timesheet',
  'timesheet.reopen': 'Reopened your approved timesheet',
  'work_limits.update': 'Changed your work limits',
  'deletion_request.approve': 'Approved your deletion request',
  'deletion_request.reject': 'Declined your deletion request',
  'user.create': 'Created your account',
  'user.update': 'Changed your account settings',
  'team.member_set': 'Changed your team membership',
  'project.member_set': 'Changed your project membership',
  'device.enrollment_code_created': 'Created a device enrollment code for you',
  'device.revoked': 'Revoked one of your devices',
  'legal_hold.create': 'Placed a legal hold on some of your data',
  'support.viewed': 'Viewed your account during a support visit',
  'erasure.declined': 'Declined your request to erase your data',
  'erasure.approved': 'Approved your request to erase your data',
};

function describeAccess(e: AuditEventDTO): string {
  const text = ACTION_TEXT[e.action] ?? humanize(e.action);
  return e.result === 'denied' ? `${text} — access was denied` : text;
}

/** G18: ask for everything Track measured about you to be erased. Another admin decides; what a legal hold covers stays until it ends. */
function Erasure({ res, orgName, tz }: { res: ApiResource<ErasureRequestDTO | null>; orgName: string; tz: string }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  const close = () => {
    setAsking(false);
    setReason('');
    action.reset();
  };
  const submit = async () => {
    const r = await action.run(() => rd.my.requestErasure(reason.trim() || undefined));
    if (r) {
      res.mutate(() => r);
      close();
    }
  };
  return (
    <>
      <Resource {...res} label="Loading">
        {(req) => {
          const open = req && (req.status === 'pending' || req.status === 'approved');
          return (
            <>
              {req?.status === 'pending' ? (
                <Banner tone="ink" role="status" title={`You asked on ${formatDateTime(req.created_at, tz)}`}>
                  An admin at {orgName} decides. You&apos;ll be told here and by email.
                </Banner>
              ) : req?.status === 'approved' ? (
                <Banner tone="ink" role="status" title="Approved — your data is being erased">
                  You&apos;ll get an email listing what was erased and what was kept.
                </Banner>
              ) : req?.status === 'declined' ? (
                <Banner tone="warn" title={`${req.decided_by_name ?? 'An admin'} declined your request`}>
                  {req.decline_reason}
                </Banner>
              ) : null}
              {open ? null : (
                <div>
                  <Button onClick={() => setAsking(true)}>{req?.status === 'declined' ? 'Ask again' : 'Ask to erase my data'}</Button>
                </div>
              )}
            </>
          );
        }}
      </Resource>
      <Dialog
        open={asking}
        onClose={close}
        size="sm"
        title="Ask to erase your data?"
        description={`Download your data first if you want a copy. Once approved, your account at ${orgName} is closed and this can't be undone.`}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={action.busy}>
              {action.busy ? 'Sending…' : 'Send request'}
            </Button>
          </>
        }
      >
        <TextArea label="Reason (optional)" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}

/** Unread notices about this person's data stay on this page; everything else is in the bell. */
function NotificationsBanner({ items, onRead }: { items: NotificationDTO[]; onRead: (id: string) => void }) {
  const unread = items.filter((n) => !n.read_at && n.category === 'privacy');
  if (unread.length === 0) return null;
  return (
    <>
      {unread.slice(0, 3).map((n) => (
        <Banner
          key={n.id}
          tone="ink"
          role="status"
          title={n.title}
          actions={
            <Button size="sm" variant="inverse" onClick={() => onRead(n.id)}>
              Mark as read
            </Button>
          }
        >
          {n.body}
        </Banner>
      ))}
    </>
  );
}

export default function PrivacyPage() {
  const { me, timezone: tz } = useMe();
  const policy = useApi('me:policy', (signal) => rd.my.policy(signal));
  const log = useApi('me:access-log', (signal) => rd.my.accessLog(signal));
  const notes = useApi('me:notifications', (signal) => rd.my.notifications(signal));
  const myExports = useApi('me:data-exports', (signal) => rd.my.dataExports(signal));
  const erasure = useApi('me:erasure-request', (signal) => rd.my.erasureRequest(signal));

  const markRead = async (id: string) => {
    notes.mutate((prev) => prev && { ...prev, items: prev.items.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)) });
    try {
      await rd.my.markRead(id);
      announceNotificationsChanged();
    } catch {
      notes.reload();
    }
  };

  const p = policy.data;
  return (
    <>
      <PageHeader
        eyebrow="Employee · Your data"
        title="What's collected about you"
        description={
          p ? (
            <>
              Generated from the policy your agent applies right now — revision <span className="mono">{p.org_revision}</span>
              {p.published_at ? `, published ${formatDateTime(p.published_at, tz)}` : ''}
              {p.published_by ? ` by ${p.published_by}` : ''}. Nothing is collected outside a work session you started.
            </>
          ) : (
            'Nothing is collected outside a work session you started.'
          )
        }
      />

      {notes.data ? <NotificationsBanner items={notes.data.items} onRead={markRead} /> : null}

      {policy.error ? (
        <ErrorState error={policy.error} onRetry={policy.reload} />
      ) : !p ? (
        <Loading label="Loading your policy" />
      ) : (
        <div className="row">
          <Card title="While a session is active" className="grow">
            <ul className={s.items}>
              {collectionRows(p).map((it) => (
                <li key={it.key} className={s.item}>
                  <span className={s.itemText}>
                    <span className={s.itemTitle}>{it.text}</span>
                    <span className={s.itemDetail}>{it.detail}</span>
                  </span>
                  <Badge tone={it.collected ? 'solid' : 'outline'}>{it.collected ? 'Collected' : 'Off'}</Badge>
                </li>
              ))}
            </ul>
          </Card>

          <div className="grow stack">
            <Card title="Who can see it">
              <dl className={dlClass}>
                <dt>You</dt>
                <dd>Everything on this page and in My day</dd>
                {p.viewers.map((v) => (
                  <div key={`${v.user_id}-${v.relation}`} style={{ display: 'contents' }}>
                    <dt>{v.display_name}</dt>
                    <dd>
                      {RELATION[v.relation] ?? humanize(v.relation)} · {v.sees.length ? v.sees.join(', ') : 'time only'}
                    </dd>
                  </div>
                ))}
                {!p.viewers.some((v) => v.relation === 'project_manager') ? (
                  <>
                    <dt>Project managers</dt>
                    <dd>Time on their projects only</dd>
                  </>
                ) : null}
                <dt>Admins</dt>
                <dd>Account and device settings — not your activity or screenshots</dd>
              </dl>
            </Card>
            <Card title="How long it's kept">
              <dl className={`${dlClass} ${s.keep}`}>
                <dt>Screenshots</dt>
                <dd className="mono">{p.base.settings.retention.screenshot_days} days</dd>
                <dt>Minute-by-minute activity</dt>
                <dd className="mono">{p.base.settings.retention.activity_days} days</dd>
                <dt>App usage</dt>
                <dd className="mono">{p.base.settings.retention.app_usage_days} days</dd>
                <dt>Time records (sessions)</dt>
                <dd>Under {me.organization.name}&apos;s time-record retention</dd>
              </dl>
            </Card>
            <Card title="Never recorded" tone="ink">
              <p>{NEVER_COLLECTED}</p>
            </Card>
          </div>
        </div>
      )}

      <div className="row" id="your-data">
        <Card title="Download your data" subtitle="Everything Track holds about you, as a ZIP" className="grow">
          <p className="small secondary">
            Your sessions, minute-by-minute activity, app usage, screenshots, timesheets, time off and the record of who viewed your data.
          </p>
          <DataExports res={myExports} onRequest={() => rd.my.requestDataExport()} label="Prepare my download" tz={tz} />
        </Card>
        <Card title="Erase your data" className="grow">
          <p className="small secondary">
            Erases your activity, app usage, screenshots and notifications. Hours worked, timesheets and pay records stay, as &ldquo;Erased person&rdquo;, because{' '}
            {me.organization.name} must keep them. Anything under a legal hold stays until the hold ends.
          </p>
          <Erasure res={erasure} orgName={me.organization.name} tz={tz} />
        </Card>
      </div>

      <Card
        title="Who viewed your data"
        actions={
          <span className={s.links}>
            <Link href="#your-data">Download my data →</Link>
            <Link href="/me/time">Request a correction →</Link>
            {me.entitlements.includes('screenshots') ? <Link href="/me/screenshots">Request screenshot deletion →</Link> : null}
          </span>
        }
      >
        <Resource {...log} label="Loading access records">
          {(rows) =>
            rows.length === 0 ? (
              <Empty title="No one has viewed your data">Every manager or admin view of your data will be listed here.</Empty>
            ) : (
              <TableBox label="Who viewed your data">
                <table className={tableClass} style={{ minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Who</th>
                      <th scope="col">What</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows]
                      .sort((a, b) => b.created_at.localeCompare(a.created_at))
                      .map((e) => (
                        <tr key={e.id}>
                          <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                            {formatDateTime(e.created_at, tz)}
                          </td>
                          <td>{e.actor_name ?? (e.actor_type === 'system' ? 'System' : humanize(e.actor_type))}</td>
                          <td className="secondary">{describeAccess(e)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>
    </>
  );
}
