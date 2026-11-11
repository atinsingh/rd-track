'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ClientPortalProject } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { Empty, Resource } from '@/components/ui/DataState';
import { Badge, Card, Meter, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { formatDuration, formatMoney, formatPercent } from '@/lib/format';
import { t } from '@/lib/i18n';
import { BUDGET_STATUS_LABEL } from '@/lib/money';
import { clientPortal } from '@/lib/portal';
import { addDays, browserTimeZone, daysInMonth, daysRange, formatDayLabel, formatDayMonth, formatMonthYear, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { usePortalMe } from './PortalMe';
import s from './portal.module.css';

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function Budget({ b }: { b: NonNullable<ClientPortalProject['budget']> }) {
  const hours = b.kind === 'hours';
  const used = hours ? b.used_seconds : (b.used_cents ?? 0);
  const limit = hours ? (b.limit_hours ?? 0) * 3600 : (b.limit_cents ?? 0);
  const fmt = (n: number) => (hours ? formatDuration(n) : formatMoney(n, b.currency ?? 'USD'));
  const label = t('pub.portal.budgetUsed', { used: fmt(used), limit: fmt(limit), percent: formatPercent(b.used_percent) });
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="small secondary">{b.period.from ? t('pub.portal.budgetMonth') : t('pub.portal.budgetProject')}</span>
        <Badge tone={b.status === 'ok' ? 'outline' : 'warn'}>{BUDGET_STATUS_LABEL[b.status]}</Badge>
      </div>
      <Meter value={used} max={Math.max(limit, used, 1)} label={label} />
      <span className="small">{label}</span>
    </div>
  );
}

function Project({ p }: { p: ClientPortalProject }) {
  const weeks = new Map<string, number>();
  for (const d of p.daily) weeks.set(startOfWeek(d.date), (weeks.get(startOfWeek(d.date)) ?? 0) + d.seconds);
  return (
    <Card title={p.name}>
      <span className={s.hours}>{formatDuration(p.seconds)}</span>
      {weeks.size ? (
        <ul className={s.people} aria-label={t('pub.portal.byWeek', { project: p.name })}>
          {[...weeks].map(([w, sec]) => (
            <li key={w}>
              <span>
                {t('pub.portal.weekOf', { from: formatDayMonth(w), to: formatDayMonth(addDays(w, 6)) })}
              </span>
              <span className="mono">{formatDuration(sec)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{t('pub.portal.noTime')}</p>
      )}
      {p.people && p.people.length ? (
        <>
          <span className="label-mono">{t('pub.portal.who')}</span>
          <ul className={s.people}>
            {p.people.map((x) => (
              <li key={x.name}>
                <span>{x.name}</span>
                <span className="mono">{formatDuration(x.seconds)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {p.budget ? <Budget b={p.budget} /> : null}
    </Card>
  );
}

function Invoices() {
  const invoices = useApi('client:invoices', (signal) => clientPortal.invoices(signal));
  return (
    <Card title={t('pub.portal.invoices')}>
      <Resource {...invoices} label={t('pub.portal.loadingInvoices')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('pub.portal.noInvoices')}>{t('pub.portal.noInvoicesBody')}</Empty>
          ) : (
            <TableBox label={t('pub.portal.invoices')}>
              <table className={tableClass} style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('pub.portal.invoice')}</th>
                    <th scope="col">{t('pub.portal.period')}</th>
                    <th scope="col">{t('pub.portal.due')}</th>
                    <th scope="col" className={numClass}>
                      {t('pub.portal.total')}
                    </th>
                    <th scope="col">{t('pub.portal.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={`/client/invoices/${i.id}`}>{i.number ?? t('pub.portal.invoice')}</Link>
                      </td>
                      <td>
                        {formatDayMonth(i.period_from)} – {formatDayMonth(i.period_to)}
                      </td>
                      <td>{i.due_date ? formatDayLabel(i.due_date) : '—'}</td>
                      <td className={numClass}>{formatMoney(i.total_cents, i.currency)}</td>
                      <td>
                        {i.status === 'void' ? (
                          <Badge>{t('pub.portal.void')}</Badge>
                        ) : i.paid_on ? (
                          <Badge tone="solid">{t('pub.portal.paid', { date: formatDayMonth(i.paid_on) })}</Badge>
                        ) : (
                          <Badge>{t('pub.portal.unpaid')}</Badge>
                        )}
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

export default function ClientPortalHome() {
  const me = usePortalMe();
  const [tz] = useState(() => browserTimeZone());
  const [month, setMonth] = useState(() => todayInTz(tz).slice(0, 7));
  const first = `${month}-01`;
  const range = daysRange(first, daysInMonth(first), tz);
  const report = useApi(`client:report|${month}|${tz}`, (signal) => clientPortal.report(range, tz, signal));
  const thisMonth = todayInTz(tz).slice(0, 7);
  return (
    <>
      <PageHeader
        eyebrow={t('pub.portal.eyebrow', { org: me.organization.name })}
        title={me.client.name}
        description={`${t('pub.portal.description', { org: me.organization.name })}${me.client.show_people ? '' : t('pub.portal.perProject')}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button size="sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label={t('pub.portal.prevMonth')}>
              ←
            </Button>
            <strong style={{ minWidth: 140, textAlign: 'center' }}>{formatMonthYear(first)}</strong>
            <Button size="sm" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth} aria-label={t('pub.portal.nextMonth')}>
              →
            </Button>
          </div>
        }
      />
      <Resource {...report} label={t('pub.portal.working')}>
        {(r) =>
          r.projects.length === 0 ? (
            <Card>
              <Empty title={t('pub.portal.noProjects')}>{t('pub.portal.noProjectsBody', { org: me.organization.name, client: me.client.name })}</Empty>
            </Card>
          ) : (
            <>
              <Card>
                <span className="label-mono">{t('pub.portal.totalMonth')}</span>
                <span className={s.hours}>{formatDuration(r.total_seconds)}</span>
              </Card>
              <div className={s.projects}>
                {r.projects.map((p) => (
                  <Project key={p.id} p={p} />
                ))}
              </div>
            </>
          )
        }
      </Resource>
      <Invoices />
    </>
  );
}
