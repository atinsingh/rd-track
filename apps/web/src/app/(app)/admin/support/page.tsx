'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SupportGrantDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t, tPlural } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

const stateLabel = (st: SupportGrantDTO['state']) => t(`cfg.support.state.${st}`);

/** G2: RoundDigital support can read your setup only when you say so, for as long as you say. */
export default function SupportAccessPage() {
  const { access, timezone: tz } = useMe();
  const grants = useApi(access.isAdmin ? 'admin:support-grants' : null, (signal) => rd.admin.supportGrants(signal));
  const action = useAction();
  const [busy, setBusy] = useState<string | null>(null);
  if (!access.isAdmin) return <NoAccess what={t('cfg.support.noAccess')} />;

  const act = async (g: SupportGrantDTO, fn: () => Promise<SupportGrantDTO>) => {
    setBusy(g.id);
    const r = await action.run(fn);
    setBusy(null);
    if (r) grants.mutate((prev) => prev?.map((x) => (x.id === r.id ? r : x)));
  };
  const list = grants.data ?? [];
  const open = list.filter((g) => g.state === 'pending' || g.state === 'active');

  return (
    <>
      <PageHeader
        eyebrow={t('cfg.eyebrow.security')}
        title={t('cfg.support.title')}
        description={t('cfg.support.description')}
      />
      <Banner tag={t('cfg.support.tag')}>
        {t('cfg.support.seesBefore')} <Link href="/audit">{t('cfg.support.auditLog')}</Link> {t('cfg.support.seesAfter')}
      </Banner>
      <ActionError error={action.error} />
      <Resource {...grants} label={t('cfg.support.loading')}>
        {() => (
          <>
            {open.map((g) => (
              <Card
                key={g.id}
                title={
                  g.state === 'pending'
                    ? tPlural(g.requested_hours, 'cfg.support.asks.one', 'cfg.support.asks.other', { name: g.operator_name })
                    : t('cfg.support.has', { name: g.operator_name })
                }
                subtitle={
                  g.state === 'pending'
                    ? t('cfg.support.asked', { when: formatRelative(g.created_at, tz) })
                    : t('cfg.support.approvedBy', { name: g.decided_by_name ?? t('cfg.support.anAdmin'), when: formatDateTime(g.expires_at, tz) })
                }
              >
                <p>
                  <span className="label-mono">{t('cfg.support.reason')}</span>
                  <br />“{g.reason}”
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  {g.state === 'pending' ? (
                    <>
                      <Button disabled={busy === g.id} onClick={() => void act(g, () => rd.admin.denySupport(g.id))}>
                        {t('cfg.support.decline')}
                      </Button>
                      <Button variant="primary" disabled={busy === g.id} onClick={() => void act(g, () => rd.admin.approveSupport(g.id))}>
                        {tPlural(g.requested_hours, 'cfg.support.approve.one', 'cfg.support.approve.other')}
                      </Button>
                    </>
                  ) : (
                    <Button variant="danger" disabled={busy === g.id} onClick={() => void act(g, () => rd.admin.endSupport(g.id))}>
                      {t('cfg.support.end')}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
            <Card title={t('cfg.support.history')}>
              {list.length === 0 ? (
                <Empty title={t('cfg.support.never')} />
              ) : (
                <TableBox label={t('cfg.support.table')}>
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th scope="col">{t('cfg.support.colAsked')}</th>
                        <th scope="col">{t('cfg.support.colWho')}</th>
                        <th scope="col">{t('cfg.support.colHours')}</th>
                        <th scope="col">{t('cfg.support.colState')}</th>
                        <th scope="col">{t('cfg.support.colDecided')}</th>
                        <th scope="col">{t('cfg.support.colReason')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((g) => (
                        <tr key={g.id}>
                          <td className="small">{formatDateTime(g.created_at, tz)}</td>
                          <td>{g.operator_name}</td>
                          <td>{g.requested_hours}</td>
                          <td>
                            <Badge tone={g.state === 'active' || g.state === 'pending' ? 'warn' : 'outline'}>{stateLabel(g.state)}</Badge>
                            {g.ended_by ? (
                              <span className="small muted">{g.ended_by === 'tenant' ? t('cfg.support.byYou') : t('cfg.support.bySupport')}</span>
                            ) : null}
                          </td>
                          <td className="small">{g.decided_by_name ?? '—'}</td>
                          <td className="small secondary">{g.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableBox>
              )}
            </Card>
          </>
        )}
      </Resource>
    </>
  );
}
