'use client';

import { useState } from 'react';
import type { DeletionRequestDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

type Filter = 'pending' | 'all';

export default function DeletionRequestsPage() {
  const { access, timezone: tz } = useMe();
  const requests = useApi(access.isAdmin ? 'admin:deletion-requests' : null, (signal) => rd.admin.deletionRequests(signal));
  const [filter, setFilter] = useState<Filter>('pending');
  const [deciding, setDeciding] = useState<{ req: DeletionRequestDTO; approve: boolean } | null>(null);
  const action = useAction();
  if (!access.isAdmin) return <NoAccess what="Deletion requests are reviewed by org admins." />;

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
        title="Deletion requests"
        description="Requests from employees to delete one of their screenshots. Reviewers never see the image — only who asked, when and why."
      />
      <Banner tag="NOTE">
        Under self-service policy, requests without a legal hold are approved automatically and only appear here for the record. Approving
        deletes the image; the audit entry keeps the screenshot id and outcome.
      </Banner>
      <Card
        title={pendingCount ? `${plural(pendingCount, 'request')} waiting` : 'Requests'}
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
