'use client';

import Link from 'next/link';
import {
  NEVER_COLLECTED,
  describeCollection,
  type AuditEventDTO,
  type CollectionItem,
  type MyPolicyResponse,
  type NotificationDTO,
} from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { Empty, ErrorState, Loading, Resource } from '@/components/ui/DataState';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { humanize } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useApi } from '@/lib/useApi';
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
  'screenshot.list': 'Listed your screenshots',
  'screenshot.deleted': 'One of your screenshots was deleted',
  'activity.view': 'Viewed your computer activity',
  'apps.view': 'Viewed your app usage',
  'time.view': 'Viewed your sessions',
  'export.create': 'Exported data that includes you',
  'time_correction.approve': 'Approved your correction',
  'time_correction.reject': 'Rejected your correction',
  'deletion_request.approve': 'Approved your deletion request',
  'deletion_request.reject': 'Declined your deletion request',
  'user.create': 'Created your account',
  'user.update': 'Changed your account settings',
  'team.member_set': 'Changed your team membership',
  'project.member_set': 'Changed your project membership',
  'device.enrollment_code_created': 'Created a device enrollment code for you',
  'device.revoked': 'Revoked one of your devices',
  'legal_hold.create': 'Placed a legal hold on some of your data',
};

function describeAccess(e: AuditEventDTO): string {
  const text = ACTION_TEXT[e.action] ?? humanize(e.action);
  return e.result === 'denied' ? `${text} — access was denied` : text;
}

function NotificationsBanner({ items, onRead }: { items: NotificationDTO[]; onRead: (id: string) => void }) {
  const unread = items.filter((n) => !n.read_at);
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

  const markRead = async (id: string) => {
    notes.mutate((prev) => prev?.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    try {
      await rd.my.markRead(id);
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

      {notes.data ? <NotificationsBanner items={notes.data} onRead={markRead} /> : null}

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

      <Card
        title="Who viewed your data"
        actions={
          <span className={s.links}>
            <Link href="/exports">Export my data →</Link>
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
