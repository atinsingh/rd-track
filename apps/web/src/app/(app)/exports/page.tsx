'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ExportDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError } from '@/lib/api';
import { useMe } from '@/lib/me';
import { addDays, dayRange, formatDateTime, startOfMonth, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';

const KIND_LABEL: Record<ExportDTO['kind'], string> = { sessions: 'Sessions', activity_daily: 'Daily activity summary' };
const STATUS_LABEL: Record<ExportDTO['status'], string> = {
  queued: 'Queued',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

function Download({ e }: { e: ExportDTO }) {
  const [error, setError] = useState<ApiError | null>(null);
  if (e.status !== 'ready') return null;
  if (e.download_url)
    return (
      <a href={e.download_url} download rel="noopener">
        Download CSV
      </a>
    );
  const fetchLink = async () => {
    try {
      const fresh = await rd.exports.get(e.id);
      if (fresh.download_url) window.location.assign(fresh.download_url);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  return (
    <>
      <Button size="sm" variant="quiet" onClick={fetchLink}>
        Get download link
      </Button>
      <ActionError error={error} />
    </>
  );
}

export default function ExportsPage() {
  const { me, access, timezone: tz } = useMe();
  const today = todayInTz(tz);
  const [kind, setKind] = useState<ExportDTO['kind']>('sessions');
  const [from, setFrom] = useState(() => startOfMonth(today));
  const [to, setTo] = useState(today);
  const [scope, setScope] = useState<string>('me');
  const exportsRes = useApi('exports', (signal) => rd.exports.list(signal));
  const teams = useApi(access.managesTeams ? 'teams' : null, (signal) => rd.teams.list(signal));
  const create = useAction();
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
    const range = { from: dayRange(from, tz).from, to: dayRange(addDays(to, 0), tz).to };
    const target =
      scope === 'me' ? { user_id: me.user.id } : { team_id: scope.replace(/^team:/, '') };
    const r = await create.run(() => rd.exports.create({ kind, ...range, ...target }));
    if (r) exportsRes.mutate((prev) => [r, ...(prev ?? [])]);
  };

  return (
    <>
      <PageHeader
        eyebrow="Exports · CSV"
        title="Exports"
        description="Download your records as CSV. Files are prepared in the background and expire after 24 hours. Every export is recorded in the audit log."
      />
      <Card title="New export">
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className={formGridClass}>
            <SelectField label="What" value={kind} onChange={(e) => setKind(e.target.value as ExportDTO['kind'])}>
              <option value="sessions">Sessions (one row per session)</option>
              <option value="activity_daily">Daily activity summary</option>
            </SelectField>
            <SelectField label="Whose data" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="me">Just me</option>
              {(teams.data ?? []).map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  Team {t.name}
                </option>
              ))}
            </SelectField>
            <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <TextField
              label="To"
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              error={from > to ? 'The end date is before the start date.' : null}
              hint={`Whole days in ${tz}`}
            />
          </div>
          <ActionError error={create.error} />
          <div className={formActionsClass}>
            <Button type="submit" variant="primary" disabled={create.busy || from > to}>
              {create.busy ? 'Queuing…' : 'Create export →'}
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Your exports" subtitle={inFlight ? 'Refreshing every few seconds while files are prepared' : undefined}>
        <Resource {...exportsRes} label="Loading exports">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No exports yet" />
            ) : (
              <TableBox label="Your exports">
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">Created</th>
                      <th scope="col">What</th>
                      <th scope="col">Range</th>
                      <th scope="col">Status</th>
                      <th scope="col" className={numClass}>
                        Rows
                      </th>
                      <th scope="col">Expires</th>
                      <th scope="col">
                        <span className="visually-hidden">Download</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody aria-live="polite">
                    {[...list]
                      .sort((a, b) => b.created_at.localeCompare(a.created_at))
                      .map((e) => (
                        <tr key={e.id}>
                          <td className="mono small">{formatDateTime(e.created_at, tz)}</td>
                          <td>{KIND_LABEL[e.kind]}</td>
                          <td className="mono small">
                            {e.from.slice(0, 10)} – {e.to.slice(0, 10)}
                            {e.user_count > 1 ? ` · ${e.user_count} people` : ''}
                          </td>
                          <td>
                            <Badge tone={e.status === 'ready' ? 'solid' : e.status === 'failed' ? 'warn' : 'outline'}>{STATUS_LABEL[e.status]}</Badge>
                          </td>
                          <td className={numClass}>{e.row_count ?? '—'}</td>
                          <td className="mono small">{formatDateTime(e.expires_at, tz)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <Download e={e} />
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
