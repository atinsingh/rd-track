'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SupportGrantDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

const STATE_LABEL: Record<SupportGrantDTO['state'], string> = { pending: 'Waiting for you', active: 'Open', expired: 'Expired', denied: 'Declined', ended: 'Ended' };

/** G2: RoundDigital support can read your setup only when you say so, for as long as you say. */
export default function SupportAccessPage() {
  const { access, timezone: tz } = useMe();
  const grants = useApi(access.isAdmin ? 'admin:support-grants' : null, (signal) => rd.admin.supportGrants(signal));
  const action = useAction();
  const [busy, setBusy] = useState<string | null>(null);
  if (!access.isAdmin) return <NoAccess what="Support access is decided by org admins." />;

  const act = async (g: SupportGrantDTO, fn: () => Promise<SupportGrantDTO>) => {
    setBusy(g.id);
    const r = await action.run(fn);
    setBusy(null);
    if (r) grants.mutate((prev) => prev?.map((x) => (x.id === r.id ? r : x)));
  };
  const list = grants.data ?? [];
  const open = list.filter((g) => g.state === 'pending' || g.state === 'active');

  return (
    <>
      <PageHeader
        eyebrow="Settings · Security"
        title="Support access"
        description="RoundDigital support can't see anything in your organization unless you approve it here, for the hours you approve."
      />
      <Banner tag="WHAT THEY SEE">
        With access open, support can read people, teams, computers, policies and the audit log — read-only. Never activity, apps, screenshots, time
        or money. Every page they open is in your <Link href="/audit">audit log</Link> as “RoundDigital support”.
      </Banner>
      <ActionError error={action.error} />
      <Resource {...grants} label="Loading support requests">
        {() => (
          <>
            {open.map((g) => (
              <Card
                key={g.id}
                title={g.state === 'pending' ? `${g.operator_name} asks for ${g.requested_hours} ${g.requested_hours === 1 ? 'hour' : 'hours'} of access` : `${g.operator_name} has access`}
                subtitle={
                  g.state === 'pending'
                    ? `Asked ${formatRelative(g.created_at, tz)}`
                    : `Approved by ${g.decided_by_name ?? 'an admin'} · ends ${formatDateTime(g.expires_at, tz)}`
                }
              >
                <p>
                  <span className="label-mono">Reason</span>
                  <br />“{g.reason}”
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  {g.state === 'pending' ? (
                    <>
                      <Button disabled={busy === g.id} onClick={() => void act(g, () => rd.admin.denySupport(g.id))}>
                        Decline
                      </Button>
                      <Button variant="primary" disabled={busy === g.id} onClick={() => void act(g, () => rd.admin.approveSupport(g.id))}>
                        Approve for {g.requested_hours} {g.requested_hours === 1 ? 'hour' : 'hours'}
                      </Button>
                    </>
                  ) : (
                    <Button variant="danger" disabled={busy === g.id} onClick={() => void act(g, () => rd.admin.endSupport(g.id))}>
                      End access now
                    </Button>
                  )}
                </div>
              </Card>
            ))}
            <Card title="History">
              {list.length === 0 ? (
                <Empty title="RoundDigital support has never asked for access" />
              ) : (
                <TableBox label="Support requests">
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th scope="col">Asked</th>
                        <th scope="col">Who</th>
                        <th scope="col">Hours</th>
                        <th scope="col">State</th>
                        <th scope="col">Decided by</th>
                        <th scope="col">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((g) => (
                        <tr key={g.id}>
                          <td className="small">{formatDateTime(g.created_at, tz)}</td>
                          <td>{g.operator_name}</td>
                          <td>{g.requested_hours}</td>
                          <td>
                            <Badge tone={g.state === 'active' || g.state === 'pending' ? 'warn' : 'outline'}>{STATE_LABEL[g.state]}</Badge>
                            {g.ended_by ? <span className="small muted"> by {g.ended_by === 'tenant' ? 'you' : 'support'}</span> : null}
                          </td>
                          <td className="small">{g.decided_by_name ?? '—'}</td>
                          <td className="small secondary">{g.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableBox>
              )}
            </Card>
          </>
        )}
      </Resource>
    </>
  );
}
