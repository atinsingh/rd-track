'use client';

import { useState, type FormEvent } from 'react';
import type { AuditEventDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formGridClass, tableClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError, type AuditQuery } from '@/lib/api';
import { humanize } from '@/lib/format';
import { useMe } from '@/lib/me';
import { addDays, dayRange, formatDateTime, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { NoAccess } from '../NoAccess';

interface Filters {
  from: string;
  to: string;
  action: string;
  actor: string;
}

export default function AuditPage() {
  const { access, timezone: tz } = useMe();
  const today = todayInTz(tz);
  const [draft, setDraft] = useState<Filters>({ from: addDays(today, -6), to: today, action: '', actor: '' });
  const [applied, setApplied] = useState<Filters>(draft);
  const [more, setMore] = useState<{ key: string; items: AuditEventDTO[]; cursor: string | null } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const allowed = access.isAdmin || access.isAuditor;

  const query: AuditQuery = {
    from: applied.from ? dayRange(applied.from, tz).from : undefined,
    to: applied.to ? dayRange(applied.to, tz).to : undefined,
    action: applied.action.trim() || undefined,
    actor_id: applied.actor.trim() || undefined,
  };
  const key = JSON.stringify(query);
  const first = useApi(allowed ? `audit|${key}` : null, (signal) => rd.audit(query, signal));
  if (!allowed) return <NoAccess what="The audit log is for auditors and org admins." />;

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
        eyebrow="Audit · Append-only"
        title="Audit log"
        description="Every sensitive action and every view of someone's data. Entries can't be edited or deleted."
      />
      <Card title="Filter">
        <form onSubmit={apply} style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <div className={formGridClass} style={{ flex: '1 1 600px' }}>
            <TextField label="From" type="date" value={draft.from} max={draft.to || today} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <TextField label="To" type="date" value={draft.to} min={draft.from} max={today} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            <TextField label="Action" placeholder="e.g. screenshot.view" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            <TextField label="Actor ID" placeholder="User id" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
          </div>
          <Button type="submit" variant="primary">
            Apply
          </Button>
        </form>
      </Card>
      <Banner tag="NOTE">Only who, what, when and the outcome are shown — never the content of what was viewed.</Banner>
      <Card title="Events">
        {first.error ? (
          <ErrorState error={first.error} onRetry={first.reload} />
        ) : !first.data ? (
          <Loading label="Loading events" />
        ) : items.length === 0 ? (
          <Empty title="No events match these filters" />
        ) : (
          <>
            <TableBox label="Audit events">
              <table className={tableClass} style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Result</th>
                    <th scope="col">Request ID</th>
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
                      <td>
                        <Badge tone={e.result === 'success' ? 'outline' : 'warn'}>{e.result}</Badge>
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
                  {moreBusy ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : (
              <p className="small muted">End of results.</p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
