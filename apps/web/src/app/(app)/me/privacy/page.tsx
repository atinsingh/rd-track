'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
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
import { t, type MessageKey } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { describeAccess, describeCollectionLocalized, viewerSees } from '@/lib/privacy';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi, type ApiResource } from '@/lib/useApi';
import s from './privacy.module.css';

interface Row extends CollectionItem {
  scope?: string;
}

/** Base items, plus per-project lines where a project's policy differs (e.g. screenshots on Client A). */
function collectionRows(policy: MyPolicyResponse): Row[] {
  const base = describeCollectionLocalized(policy.base.settings);
  const rows: Row[] = [...base];
  for (const p of policy.projects) {
    const items = describeCollectionLocalized(p.settings);
    for (const it of items) {
      const b = base.find((x) => x.key === it.key);
      if (b && b.collected !== it.collected) {
        const at = rows.findIndex((r) => r.key === it.key);
        rows.splice(at + 1, 0, { ...it, key: `${it.key}@${p.project_id}`, text: t('collect.onProject', { text: it.text, project: p.project_name }), scope: p.project_name });
      }
    }
  }
  return rows;
}

const relationText = (r: string) => (r === 'team_manager' || r === 'project_manager' ? t(`privacy.relation.${r}` as MessageKey) : humanize(r));

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
      <Resource {...res} label={t('common.loading')}>
        {(req) => {
          const open = req && (req.status === 'pending' || req.status === 'approved');
          return (
            <>
              {req?.status === 'pending' ? (
                <Banner tone="ink" role="status" title={t('privacy.askedOn', { when: formatDateTime(req.created_at, tz) })}>
                  {t('privacy.adminDecides', { org: orgName })}
                </Banner>
              ) : req?.status === 'approved' ? (
                <Banner tone="ink" role="status" title={t('privacy.approvedTitle')}>
                  {t('privacy.approvedBody')}
                </Banner>
              ) : req?.status === 'declined' ? (
                <Banner tone="warn" title={t('privacy.declinedBy', { name: req.decided_by_name ?? t('privacy.anAdmin') })}>
                  {req.decline_reason}
                </Banner>
              ) : null}
              {open ? null : (
                <div>
                  <Button onClick={() => setAsking(true)}>{req?.status === 'declined' ? t('privacy.askAgain') : t('privacy.askErase')}</Button>
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
        title={t('privacy.askTitle')}
        description={t('privacy.askBody', { org: orgName })}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={submit} disabled={action.busy}>
              {action.busy ? t('privacy.sending') : t('privacy.send')}
            </Button>
          </>
        }
      >
        <TextArea label={t('privacy.reasonOptional')} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
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
              {t('privacy.markRead')}
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
        eyebrow={t('privacy.eyebrow')}
        title={t('privacy.title')}
        description={
          p ? (
            <>
              {t('privacy.generated', { revision: p.org_revision })}
              {p.published_at ? t('privacy.publishedAt', { when: formatDateTime(p.published_at, tz) }) : ''}
              {p.published_by ? t('privacy.publishedBy', { name: p.published_by }) : ''}. {t('privacy.onlyInSession')}
            </>
          ) : (
            t('privacy.onlyInSession')
          )
        }
      />

      {notes.data ? <NotificationsBanner items={notes.data.items} onRead={markRead} /> : null}

      {policy.error ? (
        <ErrorState error={policy.error} onRetry={policy.reload} />
      ) : !p ? (
        <Loading label={t('privacy.loadingPolicy')} />
      ) : (
        <div className="row">
          <Card title={t('privacy.whileActive')} className="grow">
            <ul className={s.items}>
              {collectionRows(p).map((it) => (
                <li key={it.key} className={s.item}>
                  <span className={s.itemText}>
                    <span className={s.itemTitle}>{it.text}</span>
                    <span className={s.itemDetail}>{it.detail}</span>
                  </span>
                  <Badge tone={it.collected ? 'solid' : 'outline'}>{it.collected ? t('privacy.collected') : t('privacy.off')}</Badge>
                </li>
              ))}
            </ul>
          </Card>

          <div className="grow stack">
            <Card title={t('privacy.whoSees')}>
              <dl className={dlClass}>
                <dt>{t('privacy.you')}</dt>
                <dd>{t('privacy.youSee')}</dd>
                {p.viewers.map((v) => (
                  <div key={`${v.user_id}-${v.relation}`} style={{ display: 'contents' }}>
                    <dt>{v.display_name}</dt>
                    <dd>
                      {relationText(v.relation)} · {v.sees.length ? v.sees.map(viewerSees).join(', ') : t('privacy.timeOnly')}
                    </dd>
                  </div>
                ))}
                {!p.viewers.some((v) => v.relation === 'project_manager') ? (
                  <>
                    <dt>{t('privacy.projectManagers')}</dt>
                    <dd>{t('privacy.pmSee')}</dd>
                  </>
                ) : null}
                <dt>{t('privacy.admins')}</dt>
                <dd>{t('privacy.adminsSee')}</dd>
              </dl>
            </Card>
            <Card title={t('privacy.kept')}>
              <dl className={`${dlClass} ${s.keep}`}>
                <dt>{t('privacy.keptShots')}</dt>
                <dd className="mono">{t('privacy.days', { n: p.base.settings.retention.screenshot_days })}</dd>
                <dt>{t('privacy.keptActivity')}</dt>
                <dd className="mono">{t('privacy.days', { n: p.base.settings.retention.activity_days })}</dd>
                <dt>{t('privacy.keptApps')}</dt>
                <dd className="mono">{t('privacy.days', { n: p.base.settings.retention.app_usage_days })}</dd>
                <dt>{t('privacy.keptTime')}</dt>
                <dd>{t('privacy.keptTimeValue', { org: me.organization.name })}</dd>
              </dl>
            </Card>
            <Card title={t('privacy.never')} tone="ink">
              <p>{t('auth.neverList')}</p>
            </Card>
          </div>
        </div>
      )}

      <div className="row" id="your-data">
        <Card title={t('privacy.download')} subtitle={t('privacy.downloadSubtitle')} className="grow">
          <p className="small secondary">{t('privacy.downloadBody')}</p>
          <DataExports res={myExports} onRequest={() => rd.my.requestDataExport()} label={t('privacy.prepare')} tz={tz} />
        </Card>
        <Card title={t('privacy.erase')} className="grow">
          <p className="small secondary">{t('privacy.eraseBody', { org: me.organization.name })}</p>
          <Erasure res={erasure} orgName={me.organization.name} tz={tz} />
        </Card>
      </div>

      <Card
        title={t('privacy.whoViewed')}
        actions={
          <span className={s.links}>
            <Link href="#your-data">{t('privacy.downloadLink')}</Link>
            <Link href="/me/time">{t('privacy.correctionLink')}</Link>
            {me.entitlements.includes('screenshots') ? <Link href="/me/screenshots">{t('privacy.shotDeletionLink')}</Link> : null}
          </span>
        }
      >
        <Resource {...log} label={t('privacy.loadingAccess')}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty title={t('privacy.noViews')}>{t('privacy.noViewsBody')}</Empty>
            ) : (
              <TableBox label={t('privacy.whoViewed')}>
                <table className={tableClass} style={{ minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('privacy.when')}</th>
                      <th scope="col">{t('privacy.who')}</th>
                      <th scope="col">{t('privacy.what')}</th>
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
                          <td>{e.actor_name ?? (e.actor_type === 'system' ? t('privacy.system') : humanize(e.actor_type))}</td>
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
