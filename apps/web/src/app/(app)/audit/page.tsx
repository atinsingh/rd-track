'use client';

import { useState, type FormEvent } from 'react';
import { AUDIT_EXPORT_MAX_ROWS, type AuditEventDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formGridClass, tableClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError, type AuditQuery } from '@/lib/api';
import { formatNumber, humanize } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, dayRange, formatDateTime, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import { NoAccess } from '../NoAccess';

interface Filters {
  from: string;
  to: string;
  action: string;
  actor: string;
  subject: string;
}

export default function AuditPage() {
  const { access, timezone: tz } = useMe();
  const today = todayInTz(tz);
  const [draft, setDraft] = useState<Filters>({ from: addDays(today, -6), to: today, action: '', actor: '', subject: '' });
  const [applied, setApplied] = useState<Filters>(draft);
  const [more, setMore] = useState<{ key: string; items: AuditEventDTO[]; cursor: string | null } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const allowed = access.isAdmin || access.isAuditor;

  const query: AuditQuery = {
    from: applied.from ? dayRange(applied.from, tz).from : undefined,
    to: applied.to ? dayRange(applied.to, tz).to : undefined,
    action: applied.action.trim() || undefined,
    actor_id: applied.actor || undefined,
    subject_id: applied.subject || undefined,
  };
  const key = JSON.stringify(query);
  const first = useApi(allowed ? `audit|${key}` : null, (signal) => rd.audit(query, signal));
  const people = useApi(allowed ? 'audit:people' : null, (signal) => rd.auditPeople(signal));
  const nameOf = (id: string | null) => (id ? people.data?.find((p) => p.id === id)?.display_name : undefined);
  if (!allowed) return <NoAccess what={t('mgr.audit.noAccess')} />;

  const extra = more?.key === key ? more : null;
  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : (first.data?.next_cursor ?? null);

  const loadMore = async () => {
    if (!cursor) return;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await rd.audit({ ...query, cursor });
      setMore({ key, items: [...(extra?.items ?? []), ...page.items], cursor: page.next_cursor });
    } catch (e) {
      setMoreError(toApiError(e));
    } finally {
      setMoreBusy(false);
    }
  };

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied(draft);
    setMore(null);
  };

  return (
    <>
      <PageHeader
        eyebrow={t('mgr.audit.eyebrow')}
        title={t('nav.audit')}
        description={t('mgr.audit.description')}
      />
      <Card title={t('mgr.audit.filter')}>
        <form onSubmit={apply} style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <div className={formGridClass} style={{ flex: '1 1 600px' }}>
            <TextField label={t('mgr.audit.from')} type="date" value={draft.from} max={draft.to || today} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <TextField label={t('mgr.audit.to')} type="date" value={draft.to} min={draft.from} max={today} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            <TextField label={t('mgr.audit.action')} placeholder={t('mgr.audit.actionPh')} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            <SelectField label={t('mgr.audit.doneBy')} value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })}>
              <option value="">{t('mgr.audit.anyone')}</option>
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                  {p.status === 'active' ? '' : ` (${t(`mgr.status.${p.status}`)})`}
                </option>
              ))}
            </SelectField>
            <SelectField label={t('mgr.audit.about')} hint={t('mgr.audit.aboutHint')} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })}>
              <option value="">{t('mgr.audit.anyone')}</option>
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                  {p.status === 'active' ? '' : ` (${t(`mgr.status.${p.status}`)})`}
                </option>
              ))}
            </SelectField>
          </div>
          <Button type="submit" variant="primary">
            {t('mgr.audit.apply')}
          </Button>
        </form>
      </Card>
      <Banner tag="NOTE">{t('mgr.audit.note')}</Banner>
      <Card
        title={t('mgr.audit.events')}
        actions={
          <a className="small" href={rd.auditExportUrl(query)} download>
            {t('mgr.audit.download')}
          </a>
        }
        subtitle={t('mgr.audit.csvNote', { n: formatNumber(AUDIT_EXPORT_MAX_ROWS, 0) })}
      >
        {first.error ? (
          <ErrorState error={first.error} onRetry={first.reload} />
        ) : !first.data ? (
          <Loading label={t('mgr.audit.loading')} />
        ) : items.length === 0 ? (
          <Empty title={t('mgr.audit.none')} />
        ) : (
          <>
            <TableBox label={t('mgr.audit.label')}>
              <table className={tableClass} style={{ minWidth: 1000 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('mgr.audit.col.time')}</th>
                    <th scope="col">{t('mgr.audit.col.actor')}</th>
                    <th scope="col">{t('mgr.audit.action')}</th>
                    <th scope="col">{t('mgr.audit.col.target')}</th>
                    <th scope="col">{t('mgr.audit.about')}</th>
                    <th scope="col">{t('mgr.audit.col.result')}</th>
                    <th scope="col">{t('mgr.audit.col.request')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id}>
                      <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(e.created_at, tz)}
                      </td>
                      <td>
                        <span style={{ display: 'flex', flexDirection: 'column' }}>
                          <span>{e.actor_name ?? humanize(e.actor_type)}</span>
                          <span className="small muted">
                            {humanize(e.actor_type)}
                            {e.actor_id ? ` · ${e.actor_id.slice(0, 8)}` : ''}
                          </span>
                        </span>
                      </td>
                      <td className="mono small">{e.action}</td>
                      <td className="small">
                        {e.target_type ? humanize(e.target_type) : '—'}
                        {e.target_id ? <span className="mono muted"> · {e.target_id.slice(0, 8)}</span> : null}
                      </td>
                      <td className="small">{e.target_user_id ? (nameOf(e.target_user_id) ?? e.target_user_id.slice(0, 8)) : '—'}</td>
                      <td>
                        <Badge tone={e.result === 'success' ? 'outline' : 'warn'}>{t(`mgr.audit.result.${e.result}`)}</Badge>
                      </td>
                      <td className="mono small muted">{e.request_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
            <ActionError error={moreError} />
            {cursor ? (
              <div>
                <Button onClick={loadMore} disabled={moreBusy}>
                  {moreBusy ? t('mgr.audit.loadingMore') : t('mgr.audit.loadMore')}
                </Button>
              </div>
            ) : (
              <p className="small muted">{t('mgr.audit.end')}</p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
