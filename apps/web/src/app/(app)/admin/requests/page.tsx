'use client';

import { useState } from 'react';
import type { DeletionRequestDTO, ErasureRequestDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented, TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { humanize, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi, type ApiResource } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

type Filter = 'pending' | 'all';

const ERASURE_STATUS: Record<ErasureRequestDTO['status'], string> = { pending: 'Pending', approved: 'Erasing', declined: 'Declined', completed: 'Erased' };
const counts = (r: Record<string, number>) =>
  Object.entries(r)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${humanize(k).toLowerCase()}`)
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
    <Card title={waiting ? `${plural(waiting, 'erasure request')} waiting` : 'Erasure requests'} subtitle="People asking for everything Track measured about them to be erased">
      <Resource {...res} label="Loading erasure requests">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No erasure requests" />
          ) : (
            <TableBox label="Erasure requests">
              <table className={tableClass} style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th scope="col">Requested</th>
                    <th scope="col">Person</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
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
                        {r.status === 'declined' && r.decline_reason ? <div>Declined: {r.decline_reason}</div> : null}
                        {r.result ? (
                          <div>
                            Erased {counts(r.result.deleted) || 'nothing measured'}
                            {counts(r.result.kept_for_legal_hold) ? ` · kept for a legal hold: ${counts(r.result.kept_for_legal_hold)}` : ''}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={r.status === 'pending' ? 'outline' : r.status === 'declined' ? 'warn' : 'solid'}>{ERASURE_STATUS[r.status]}</Badge>
                        {r.decided_by_name ? <span className="small muted"> · {r.decided_by_name}</span> : null}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.status === 'pending' && r.user_id !== myId ? (
                          <span style={{ display: 'inline-flex', gap: 8 }}>
                            <Button size="sm" variant="quiet" onClick={() => setDeciding({ req: r, approve: false })}>
                              Decline
                            </Button>
                            <Button size="sm" variant="primary" onClick={() => setDeciding({ req: r, approve: true })}>
                              Approve
                            </Button>
                          </span>
                        ) : r.status === 'pending' ? (
                          <span className="small muted">Another admin decides</span>
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
        title={deciding?.approve ? `Erase ${deciding.req.user_name}'s data?` : 'Decline this request?'}
        description={
          deciding?.approve
            ? 'Their account is closed now. Activity, app usage and screenshots are deleted, except what a legal hold covers. Hours, timesheets and pay stay under "Erased person". This can\'t be undone.'
            : `${deciding?.req.user_name ?? 'They'} will see your reason.`
        }
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={decide} disabled={action.busy || (!deciding?.approve && reason.trim().length < 3)}>
              {action.busy ? 'Saving…' : deciding?.approve ? 'Approve and erase' : 'Decline request'}
            </Button>
          </>
        }
      >
        {deciding && !deciding.approve ? <TextArea label="Reason" required rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
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
  if (!access.isAdmin) return <NoAccess what="Data requests are reviewed by org admins." />;

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
        eyebrow="Admin · Employee requests"
        title="Data requests"
        description="Employees asking to erase their data, or to delete one of their screenshots. Reviewers never see the data — only who asked, when and why."
      />
      <ErasureRequests res={erasures} tz={tz} myId={me.user.id} />
      <Banner tag="NOTE">
        Under self-service policy, requests without a legal hold are approved automatically and only appear here for the record. Approving
        deletes the image; the audit entry keeps the screenshot id and outcome.
      </Banner>
      <Card
        title={pendingCount ? `${plural(pendingCount, 'screenshot deletion')} waiting` : 'Screenshot deletions'}
        actions={
          <Segmented<Filter>
            legend="Show"
            name="req-filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      >
        <Resource {...requests} label="Loading requests">
          {(list) => {
            const rows = list
              .filter((r) => filter === 'all' || r.status === 'pending')
              .sort((a, b) => (filter === 'pending' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
            return rows.length === 0 ? (
              <Empty title={filter === 'pending' ? 'Nothing waiting for review' : 'No requests yet'} />
            ) : (
              <TableBox label="Deletion requests">
                <table className={tableClass} style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th scope="col">Requested</th>
                      <th scope="col">Person</th>
                      <th scope="col">Screenshot</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
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
                          <Badge tone={r.status === 'pending' ? 'outline' : 'solid'}>{r.status}</Badge>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {r.status === 'pending' ? (
                            <span style={{ display: 'inline-flex', gap: 8 }}>
                              <Button size="sm" variant="quiet" onClick={() => setDeciding({ req: r, approve: false })}>
                                Reject
                              </Button>
                              <Button size="sm" variant="primary" onClick={() => setDeciding({ req: r, approve: true })}>
                                Approve
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
        title={deciding?.approve ? 'Approve and delete the screenshot?' : 'Reject this request?'}
        description={
          deciding?.approve
            ? `The image is deleted permanently. ${deciding.req.requester_name} is told it was deleted.`
            : `The screenshot stays until its retention date. ${deciding?.req.requester_name ?? 'The person'} is told the request was declined.`
        }
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>Cancel</Button>
            <Button variant="primary" onClick={decide} disabled={action.busy}>
              {action.busy ? 'Saving…' : deciding?.approve ? 'Approve and delete' : 'Reject request'}
            </Button>
          </>
        }
      >
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}
