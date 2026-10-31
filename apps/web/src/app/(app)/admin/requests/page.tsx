'use client';

import { useState } from 'react';
import type { DeletionRequestDTO, ErasureRequestDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented, TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { humanize } from '@/lib/format';
import { t, tPlural } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi, type ApiResource } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

type Filter = 'pending' | 'all';

/** What an erasure removes, by table (apps/api lifecycle/person.ts); anything newer falls back to its name. */
const ERASED_TABLES = [
  'activity_buckets',
  'app_usage',
  'data_gaps',
  'idle_decisions',
  'screenshots',
  'expenses',
  'notifications',
  'notification_preferences',
  'auth_tokens',
  'mfa_recovery_codes',
  'enrollment_codes',
  'user_sessions',
  'data_exports',
] as const;
type ErasedTable = (typeof ERASED_TABLES)[number];
const tableLabel = (k: string) => ((ERASED_TABLES as readonly string[]).includes(k) ? t(`adm.req.tbl.${k as ErasedTable}`) : humanize(k).toLowerCase());
const counts = (r: Record<string, number>) =>
  Object.entries(r)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${tableLabel(k)}`)
    .join(', ');

/** G18: an employee asks for their data to be erased; another admin decides. */
function ErasureRequests({ res, tz, myId }: { res: ApiResource<ErasureRequestDTO[]>; tz: string; myId: string }) {
  const [deciding, setDeciding] = useState<{ req: ErasureRequestDTO; approve: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const action = useAction();
  const close = () => {
    setDeciding(null);
    setReason('');
    action.reset();
  };
  const decide = async () => {
    if (!deciding) return;
    const { req, approve } = deciding;
    const r = await action.run(() => (approve ? rd.admin.approveErasure(req.id) : rd.admin.declineErasure(req.id, reason.trim())));
    if (r) {
      res.mutate((prev) => prev?.map((x) => (x.id === r.id ? r : x)));
      close();
    }
  };
  const waiting = (res.data ?? []).filter((r) => r.status === 'pending').length;
  return (
    <Card
      title={waiting ? tPlural(waiting, 'adm.req.erWaiting.one', 'adm.req.erWaiting.other') : t('adm.req.erTitle')}
      subtitle={t('adm.req.erSub')}
    >
      <Resource {...res} label={t('adm.req.erLoading')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('adm.req.erNone')} />
          ) : (
            <TableBox label={t('adm.req.erTitle')}>
              <table className={tableClass} style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('adm.req.requested')}</th>
                    <th scope="col">{t('adm.common.person')}</th>
                    <th scope="col">{t('adm.req.reason')}</th>
                    <th scope="col">{t('adm.req.status')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('adm.common.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(r.created_at, tz)}
                      </td>
                      <td style={{ fontWeight: 600 }}>{r.user_name}</td>
                      <td className="small secondary">
                        {r.reason ?? '—'}
                        {r.status === 'declined' && r.decline_reason ? <div>{t('adm.req.declinedColon', { reason: r.decline_reason })}</div> : null}
                        {r.result ? (
                          <div>
                            {t('adm.req.erasedList', { list: counts(r.result.deleted) || t('adm.req.nothingMeasured') })}
                            {counts(r.result.kept_for_legal_hold) ? t('adm.req.keptHold', { list: counts(r.result.kept_for_legal_hold) }) : ''}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={r.status === 'pending' ? 'outline' : r.status === 'declined' ? 'warn' : 'solid'}>{t(`adm.req.er.${r.status}`)}</Badge>
                        {r.decided_by_name ? <span className="small muted"> · {r.decided_by_name}</span> : null}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.status === 'pending' && r.user_id !== myId ? (
                          <span style={{ display: 'inline-flex', gap: 8 }}>
                            <Button size="sm" variant="quiet" onClick={() => setDeciding({ req: r, approve: false })}>
                              {t('adm.req.decline')}
                            </Button>
                            <Button size="sm" variant="primary" onClick={() => setDeciding({ req: r, approve: true })}>
                              {t('adm.req.approve')}
                            </Button>
                          </span>
                        ) : r.status === 'pending' ? (
                          <span className="small muted">{t('adm.req.anotherAdmin')}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
          )
        }
      </Resource>
      <Dialog
        open={deciding !== null}
        onClose={close}
        size="sm"
        title={deciding?.approve ? t('adm.req.eraseTitle', { name: deciding.req.user_name }) : t('adm.req.declineTitle')}
        description={deciding?.approve ? t('adm.req.eraseBody') : t('adm.req.seeReason', { name: deciding?.req.user_name ?? t('adm.req.they') })}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={decide} disabled={action.busy || (!deciding?.approve && reason.trim().length < 3)}>
              {action.busy ? t('common.saving') : deciding?.approve ? t('adm.req.approveErase') : t('adm.req.declineRequest')}
            </Button>
          </>
        }
      >
        {deciding && !deciding.approve ? <TextArea label={t('adm.req.reason')} required rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
        <ActionError error={action.error} />
      </Dialog>
    </Card>
  );
}

export default function DeletionRequestsPage() {
  const { me, access, timezone: tz } = useMe();
  const requests = useApi(access.isAdmin ? 'admin:deletion-requests' : null, (signal) => rd.admin.deletionRequests(signal));
  const erasures = useApi(access.isAdmin ? 'admin:erasure-requests' : null, (signal) => rd.admin.erasureRequests(signal));
  const [filter, setFilter] = useState<Filter>('pending');
  const [deciding, setDeciding] = useState<{ req: DeletionRequestDTO; approve: boolean } | null>(null);
  const action = useAction();
  if (!access.isAdmin) return <NoAccess what={t('adm.req.noAccess')} />;

  const pendingCount = (requests.data ?? []).filter((r) => r.status === 'pending').length;

  const decide = async () => {
    if (!deciding) return;
    const { req, approve } = deciding;
    const r = await action.run(() => (approve ? rd.admin.approveDeletion(req.id) : rd.admin.rejectDeletion(req.id)));
    if (r) {
      requests.mutate((prev) => prev?.map((x) => (x.id === req.id ? { ...x, status: approve ? 'approved' : 'rejected' } : x)));
      setDeciding(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('adm.req.eyebrow')}
        title={t('adm.req.title')}
        description={t('adm.req.description')}
      />
      <ErasureRequests res={erasures} tz={tz} myId={me.user.id} />
      <Banner tag={t('adm.common.noteTag')}>{t('adm.req.banner')}</Banner>
      <Card
        title={pendingCount ? tPlural(pendingCount, 'adm.req.delWaiting.one', 'adm.req.delWaiting.other') : t('adm.req.delTitle')}
        actions={
          <Segmented<Filter>
            legend={t('adm.req.show')}
            name="req-filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: t('adm.req.filterPending') },
              { value: 'all', label: t('adm.req.filterAll') },
            ]}
          />
        }
      >
        <Resource {...requests} label={t('adm.req.loading')}>
          {(list) => {
            const rows = list
              .filter((r) => filter === 'all' || r.status === 'pending')
              .sort((a, b) => (filter === 'pending' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
            return rows.length === 0 ? (
              <Empty title={filter === 'pending' ? t('adm.req.nothingWaiting') : t('adm.req.noRequests')} />
            ) : (
              <TableBox label={t('adm.req.delTable')}>
                <table className={tableClass} style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.req.requested')}</th>
                      <th scope="col">{t('adm.common.person')}</th>
                      <th scope="col">{t('adm.req.screenshot')}</th>
                      <th scope="col">{t('adm.req.reason')}</th>
                      <th scope="col">{t('adm.req.status')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                          {formatDateTime(r.created_at, tz)}
                        </td>
                        <td style={{ fontWeight: 600 }}>{r.requester_name}</td>
                        <td className="mono small" title={r.target_id}>
                          {r.target_id.slice(0, 8)}…
                        </td>
                        <td className="small secondary">{r.reason}</td>
                        <td>
                          <Badge tone={r.status === 'pending' ? 'outline' : 'solid'}>{t(`adm.req.del.${r.status}`)}</Badge>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {r.status === 'pending' ? (
                            <span style={{ display: 'inline-flex', gap: 8 }}>
                              <Button size="sm" variant="quiet" onClick={() => setDeciding({ req: r, approve: false })}>
                                {t('adm.req.reject')}
                              </Button>
                              <Button size="sm" variant="primary" onClick={() => setDeciding({ req: r, approve: true })}>
                                {t('adm.req.approve')}
                              </Button>
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            );
          }}
        </Resource>
      </Card>
      <Dialog
        open={deciding !== null}
        onClose={() => {
          setDeciding(null);
          action.reset();
        }}
        size="sm"
        title={deciding?.approve ? t('adm.req.approveDeleteTitle') : t('adm.req.rejectTitle')}
        description={
          deciding?.approve
            ? t('adm.req.approveDeleteBody', { name: deciding.req.requester_name })
            : t('adm.req.rejectBody', { name: deciding?.req.requester_name ?? t('adm.req.thePerson') })
        }
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={decide} disabled={action.busy}>
              {action.busy ? t('common.saving') : deciding?.approve ? t('adm.req.approveDelete') : t('adm.req.rejectRequest')}
            </Button>
          </>
        }
      >
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}
