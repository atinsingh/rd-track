'use client';

import { useEffect } from 'react';
import { DATA_EXPORT_HOURS, type DataExportDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Badge, TableBox, tableClass } from '@/components/ui/Layout';
import type { ApiResource } from '@/lib/useApi';
import { formatDateTime } from '@/lib/time';
import { useAction } from '@/lib/useApi';

const STATUS: Record<DataExportDTO['status'], string> = { queued: 'Queued', running: 'Preparing', ready: 'Ready', failed: 'Failed', expired: 'Expired' };
const size = (n: number | null) => (n === null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Request a ZIP and download it while it lasts; used for the organization's export and for "My data". */
export function DataExports({ res, onRequest, label, tz }: { res: ApiResource<DataExportDTO[]>; onRequest: () => Promise<DataExportDTO>; label: string; tz: string }) {
  const action = useAction();
  const busy = (res.data ?? []).some((e) => e.status === 'queued' || e.status === 'running');
  const { reload } = res;
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(reload, 3000);
    return () => window.clearInterval(t);
  }, [busy, reload]);
  const request = async () => {
    const r = await action.run(onRequest);
    if (r) res.mutate((prev) => [r, ...(prev ?? [])]);
  };
  return (
    <>
      <div>
        <Button variant="primary" onClick={request} disabled={action.busy || busy}>
          {busy ? 'Preparing…' : label}
        </Button>
      </div>
      <ActionError error={action.error} />
      <Resource {...res} label="Loading exports">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No exports yet">{`Files can be downloaded for ${DATA_EXPORT_HOURS} hours.`}</Empty>
          ) : (
            <TableBox label="Exports">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th scope="col">Requested</th>
                    <th scope="col">State</th>
                    <th scope="col">File</th>
                    <th scope="col">
                      <span className="visually-hidden">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td className="small">{formatDateTime(e.created_at, tz)}</td>
                      <td>
                        <Badge tone={e.status === 'ready' ? 'solid' : e.status === 'failed' ? 'warn' : 'outline'}>{STATUS[e.status]}</Badge>
                      </td>
                      <td className="small">
                        {e.file_count ? `${e.file_count} files · ${size(e.size_bytes)}` : '—'}
                        {e.status === 'ready' && e.expires_at ? ` · until ${formatDateTime(e.expires_at, tz)}` : ''}
                      </td>
                      <td style={{ textAlign: 'right' }}>{e.download_url ? <a href={e.download_url}>Download ZIP</a> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
          )
        }
      </Resource>
    </>
  );
}
