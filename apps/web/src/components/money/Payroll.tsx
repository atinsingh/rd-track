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

// ───────────────────────── payroll ─────────────────────────

const EXPORT_STATUS: Record<PayrollExportDTO['status'], string> = {
  queued: 'Queued',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

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
        Download CSV
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
    const t = window.setInterval(reload, 3000);
    return () => window.clearInterval(t);
  }, [inFlight, reload]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (from > to) return;
    const r = await create.run(() => rd.money.createPayrollExport({ period_from: from, period_to: to, timezone: tz }));
    if (r) exportsRes.mutate((prev) => [r, ...(prev ?? [])]);
  };
  return (
    <Card title="Payroll export" subtitle="Hours × pay rate per person for a pay period, as CSV">
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <TextField label="Pay period from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            hint={`Whole days in ${tz}; up to 93 days`}
            error={from > to ? 'The end date is before the start date.' : null}
          />
        </div>
        <p className="small muted">
          Uses all recorded time (agent-tracked and approved manual time). Hours are rounded to the minute, then to two decimals. Files expire after 24
          hours; each download is recorded in the access log of everyone in the file.
        </p>
        <ActionError error={create.error} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={create.busy || from > to}>
            {create.busy ? 'Queuing…' : 'Create payroll export →'}
          </Button>
        </div>
      </form>
      <Resource {...exportsRes} label="Loading payroll exports">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No payroll exports yet" />
          ) : (
            <TableBox label="Payroll exports">
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">Created</th>
                    <th scope="col">Pay period</th>
                    <th scope="col">Status</th>
                    <th scope="col" className={numClass}>
                      Rows
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Download</span>
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
                        <Badge tone={e.status === 'ready' ? 'solid' : 'outline'}>{EXPORT_STATUS[e.status]}</Badge>
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
