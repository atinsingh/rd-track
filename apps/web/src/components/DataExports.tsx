'use client';

import { useEffect } from 'react';
import { DATA_EXPORT_HOURS, type DataExportDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Badge, TableBox, tableClass } from '@/components/ui/Layout';
import type { ApiResource } from '@/lib/useApi';
import { formatDateTime } from '@/lib/time';
import { useAction } from '@/lib/useApi';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';

const statusText = (st: DataExportDTO['status']) => t(`exports.status.${st}`);
const size = (n: number | null) => (n === null ? '' : formatBytes(n));

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
          {busy ? t('exports.preparing') : label}
        </Button>
      </div>
      <ActionError error={action.error} />
      <Resource {...res} label={t('exports.loading')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('exports.none')}>{t('exports.noneBody', { hours: DATA_EXPORT_HOURS })}</Empty>
          ) : (
            <TableBox label={t('exports.table')}>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th scope="col">{t('exports.requested')}</th>
                    <th scope="col">{t('exports.state')}</th>
                    <th scope="col">{t('exports.file')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('exports.download')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td className="small">{formatDateTime(e.created_at, tz)}</td>
                      <td>
                        <Badge tone={e.status === 'ready' ? 'solid' : e.status === 'failed' ? 'warn' : 'outline'}>{statusText(e.status)}</Badge>
                      </td>
                      <td className="small">
                        {e.file_count ? t('exports.files', { n: e.file_count, size: size(e.size_bytes) }) : '—'}
                        {e.status === 'ready' && e.expires_at ? t('exports.until', { when: formatDateTime(e.expires_at, tz) }) : ''}
                      </td>
                      <td style={{ textAlign: 'right' }}>{e.download_url ? <a href={e.download_url}>{t('exports.downloadZip')}</a> : null}</td>
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
