'use client';

import Link from 'next/link';
import type { SupportGrantDTO } from '@rd/contracts';
import { Empty, Resource } from '@/components/ui/DataState';
import { Badge, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { platform } from '@/lib/platform';
import { formatDateTime } from '@/lib/time';
import { useApi } from '@/lib/useApi';

const STATE_LABEL: Record<SupportGrantDTO['state'], string> = { pending: 'Waiting', active: 'Open', expired: 'Expired', denied: 'Declined', ended: 'Ended' };

/** Every support request across organizations, newest first. */
export default function SupportRequests() {
  const grants = useApi('platform:grants', (signal) => platform.grants(signal));
  return (
    <>
      <PageHeader
        eyebrow="Platform · Support access"
        title="Support access"
        description="Requests to read an organization's setup. Each one waits for that organization's admins; open access ends by itself. Times are UTC."
      />
      <Card title="Requests">
        <Resource {...grants} label="Loading requests">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No requests yet">Ask from an organization&apos;s page.</Empty>
            ) : (
              <TableBox label="Support requests">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col">Organization</th>
                      <th scope="col">Operator</th>
                      <th scope="col">Asked</th>
                      <th scope="col">Hours</th>
                      <th scope="col">State</th>
                      <th scope="col">Until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((g) => (
                      <tr key={g.id}>
                        <th scope="row">
                          <Link href={`/platform/tenants/${g.organization_id}`}>{g.organization_name}</Link>
                        </th>
                        <td>{g.operator_name}</td>
                        <td className="small">{formatDateTime(g.created_at, 'UTC')}</td>
                        <td>{g.requested_hours}</td>
                        <td>
                          <Badge tone={g.state === 'active' ? 'warn' : 'outline'}>{STATE_LABEL[g.state]}</Badge>
                        </td>
                        <td className="small">{g.state === 'active' ? formatDateTime(g.expires_at, 'UTC') : '—'}</td>
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
