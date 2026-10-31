'use client';

import { Empty, Resource } from '@/components/ui/DataState';
import { Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { platform } from '@/lib/platform';
import { formatDateTime } from '@/lib/time';
import { useApi } from '@/lib/useApi';

/** What was deleted when organizations closed: kept after the organization is gone (slice 5b). */
export default function Certificates() {
  const certs = useApi('platform:certificates', (signal) => platform.certificates(signal));
  return (
    <>
      <PageHeader
        eyebrow="Platform · Data lifecycle"
        title="Deletion certificates"
        description="One per closed organization: when it was deleted, how much, and the SHA-256 digest of the certificate its admins received. Times are UTC."
      />
      <Card title="Certificates">
        <Resource {...certs} label="Loading certificates">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No organization has been closed" />
            ) : (
              <TableBox label="Deletion certificates">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col">Organization</th>
                      <th scope="col">Deleted</th>
                      <th scope="col">Requested by</th>
                      <th scope="col" className={numClass}>
                        Records
                      </th>
                      <th scope="col" className={numClass}>
                        Files
                      </th>
                      <th scope="col">Digest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id}>
                        <th scope="row">
                          {c.organization_name} <span className="small muted">{c.organization_slug}</span>
                        </th>
                        <td className="small">{formatDateTime(c.deleted_at, 'UTC')}</td>
                        <td className="small">{c.requested_by_email ?? 'RoundDigital'}</td>
                        <td className={numClass}>{Object.values(c.rows_deleted).reduce((a, b) => a + b, 0)}</td>
                        <td className={numClass}>{c.objects_deleted}</td>
                        <td className="mono small" title={c.digest}>
                          {c.digest.slice(0, 16)}…
                        </td>
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
