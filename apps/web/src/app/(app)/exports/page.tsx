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
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/format';

const kindLabel = (k: ExportDTO['kind']): string => t(`xp.kind.${k}`);
const statusLabel = (st: ExportDTO['status']): string => t(`exports.status.${st}`);

function Download({ e }: { e: ExportDTO }) {
  const [error, setError] = useState<ApiError | null>(null);
  if (e.status !== 'ready') return null;
  if (e.download_url)
    return (
      <a href={e.download_url} download rel="noopener">
        {t('xp.downloadCsv')}
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
        {t('xp.getLink')}
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
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
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
        eyebrow={t('xp.eyebrow')}
        title={t('xp.title')}
        description={t('xp.description')}
      />
      <Card title={t('xp.new')}>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className={formGridClass}>
            <SelectField label={t('xp.what')} value={kind} onChange={(e) => setKind(e.target.value as ExportDTO['kind'])}>
              <option value="sessions">{t('xp.sessionsOption')}</option>
              <option value="activity_daily">{t('xp.kind.activity_daily')}</option>
            </SelectField>
            <SelectField label={t('xp.whose')} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="me">{t('xp.justMe')}</option>
              {(teams.data ?? []).map((team) => (
                <option key={team.id} value={`team:${team.id}`}>
                  {t('xp.team', { name: team.name })}
                </option>
              ))}
            </SelectField>
            <TextField label={t('xp.from')} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <TextField
              label={t('xp.to')}
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              error={from > to ? t('xp.endBeforeStart') : null}
              hint={t('xp.wholeDays', { tz })}
            />
          </div>
          <ActionError error={create.error} />
          <div className={formActionsClass}>
            <Button type="submit" variant="primary" disabled={create.busy || from > to}>
              {create.busy ? t('xp.queuing') : t('xp.create')}
            </Button>
          </div>
        </form>
      </Card>
      <Card title={t('xp.yours')} subtitle={inFlight ? t('xp.refreshing') : undefined}>
        <Resource {...exportsRes} label={t('exports.loading')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('exports.none')} />
            ) : (
              <TableBox label={t('xp.yours')}>
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('xp.col.created')}</th>
                      <th scope="col">{t('xp.col.what')}</th>
                      <th scope="col">{t('xp.col.range')}</th>
                      <th scope="col">{t('xp.col.status')}</th>
                      <th scope="col" className={numClass}>
                        {t('xp.col.rows')}
                      </th>
                      <th scope="col">{t('xp.col.expires')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('xp.col.download')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody aria-live="polite">
                    {[...list]
                      .sort((a, b) => b.created_at.localeCompare(a.created_at))
                      .map((e) => (
                        <tr key={e.id}>
                          <td className="mono small">{formatDateTime(e.created_at, tz)}</td>
                          <td>{kindLabel(e.kind)}</td>
                          <td className="mono small">
                            {e.from.slice(0, 10)} – {e.to.slice(0, 10)}
                            {e.user_count > 1 ? t('xp.people', { n: e.user_count }) : ''}
                          </td>
                          <td>
                            <Badge tone={e.status === 'ready' ? 'solid' : e.status === 'failed' ? 'warn' : 'outline'}>{statusLabel(e.status)}</Badge>
                          </td>
                          <td className={numClass}>{e.row_count === null || e.row_count === undefined ? '—' : formatNumber(e.row_count, 0)}</td>
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
