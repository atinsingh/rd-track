'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { PayrollExportDTO } from '@rd/contracts';
import m from '@/app/(app)/admin/money.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { Badge, Card, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError } from '@/lib/api';
import { addDays, formatDateTime, formatDayLabel, startOfMonth } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';

// ───────────────────────── payroll ─────────────────────────

const exportStatus = (st: PayrollExportDTO['status']) => t(`money.payroll.status.${st}`);

function PayrollDownload({ e }: { e: PayrollExportDTO }) {
  const [error, setError] = useState<ApiError | null>(null);
  if (e.status !== 'ready') return null;
  const fetchLink = async () => {
    try {
      const fresh = await rd.money.payrollExport(e.id);
      if (fresh.download_url) window.location.assign(fresh.download_url);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  return (
    <>
      <Button size="sm" variant="quiet" onClick={fetchLink}>
        {t('money.payroll.download')}
      </Button>
      <ActionError error={error} />
    </>
  );
}

/** Payroll export (G22): hours × pay rate per person for a pay period. Lives on Period close. */
export function Payroll({ tz, today }: { tz: string; today: string }) {
  const exportsRes = useApi('money:payroll', (signal) => rd.money.payrollExports(signal));
  const create = useAction();
  const [from, setFrom] = useState(() => startOfMonth(addDays(startOfMonth(today), -1)));
  const [to, setTo] = useState(() => addDays(startOfMonth(today), -1));
  const inFlight = (exportsRes.data ?? []).some((e) => e.status === 'queued' || e.status === 'running');
  const { reload } = exportsRes;
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
  }, [inFlight, reload]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (from > to) return;
    const r = await create.run(() => rd.money.createPayrollExport({ period_from: from, period_to: to, timezone: tz }));
    if (r) exportsRes.mutate((prev) => [r, ...(prev ?? [])]);
  };
  return (
    <Card title={t('money.payroll.title')} subtitle={t('money.payroll.subtitle')}>
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <TextField label={t('money.payroll.from')} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField
            label={t('money.payroll.to')}
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            hint={t('money.payroll.hint', { tz })}
            error={from > to ? t('money.payroll.endBefore') : null}
          />
        </div>
        <p className="small muted">
          {t('money.payroll.explain')}
        </p>
        <ActionError error={create.error} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={create.busy || from > to}>
            {create.busy ? t('money.payroll.queuing') : t('money.payroll.create')}
          </Button>
        </div>
      </form>
      <Resource {...exportsRes} label={t('money.payroll.loading')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('money.payroll.none')} />
          ) : (
            <TableBox label={t('money.payroll.table')}>
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('money.payroll.created')}</th>
                    <th scope="col">{t('money.payroll.period')}</th>
                    <th scope="col">{t('money.payroll.statusCol')}</th>
                    <th scope="col" className={numClass}>
                      {t('money.payroll.rows')}
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">{t('money.payroll.downloadCol')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDateTime(e.created_at, tz)}</td>
                      <td>
                        {formatDayLabel(e.period_from)} – {formatDayLabel(e.period_to)}
                      </td>
                      <td>
                        <Badge tone={e.status === 'ready' ? 'solid' : 'outline'}>{exportStatus(e.status)}</Badge>
                      </td>
                      <td className={numClass}>{e.row_count ?? '—'}</td>
                      <td>
                        <PayrollDownload e={e} />
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
  );
}
