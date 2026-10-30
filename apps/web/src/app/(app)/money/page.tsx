'use client';

import Link from 'next/link';
import type { MoneyOverview } from '@rd/contracts';
import { BudgetMeter } from '@/components/BudgetMeter';
import { Payroll } from '@/components/money/Payroll';
import { Empty, Resource } from '@/components/ui/DataState';
import { Badge, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { Tiles } from '@/components/workspace/Tiles';
import { rd } from '@/lib/api';
import { formatDuration, formatMoney } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDayMonth, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { invoiceStateLabel } from '@/lib/money';
import { invoiceState, totalsByCurrency } from '@/lib/workspaces';
import { t, tPlural } from '@/lib/i18n';
import { MoneyGate } from '../admin/MoneyGate';

const moneyList = (rows: readonly { currency: string; total_cents: number }[]) =>
  rows.length ? rows.map((r) => formatMoney(r.total_cents, r.currency)).join(' · ') : '—';

function OpenInvoices({ o, today }: { o: MoneyOverview; today: string }) {
  return (
    <Card title={t('money.home.toFinish')} subtitle={t('money.home.toFinishSub')} actions={<Link href="/admin/invoices">{t('money.home.allInvoices')}</Link>}>
      {o.open_invoices.length === 0 ? (
        <Empty title={t('money.home.nothingOutstanding')}>{t('money.home.allPaid')}</Empty>
      ) : (
        <TableBox label={t('money.home.openInvoices')}>
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">{t('money.col.invoice')}</th>
                <th scope="col">{t('money.col.client')}</th>
                <th scope="col">{t('money.col.period')}</th>
                <th scope="col">{t('money.col.due')}</th>
                <th scope="col">{t('money.col.state')}</th>
                <th scope="col" className={numClass}>
                  {t('money.col.total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {o.open_invoices.map((i) => {
                const state = invoiceState(i, today);
                return (
                  <tr key={i.id}>
                    <th scope="row">
                      <Link href={`/admin/invoices/${i.id}`}>{i.number ?? t('money.draft')}</Link>
                    </th>
                    <td>{i.client_name}</td>
                    <td className="small">
                      {formatDayMonth(i.period_from)} – {formatDayMonth(i.period_to)}
                    </td>
                    <td className="small">{i.due_date ? formatDayMonth(i.due_date) : '—'}</td>
                    <td>
                      <Badge tone={state === 'overdue' ? 'warn' : 'outline'}>{invoiceStateLabel(state)}</Badge>
                      {i.sent_at ? <span className="small muted">{t('money.sent')}</span> : null}
                    </td>
                    <td className={numClass}>{formatMoney(i.total_cents, i.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableBox>
      )}
    </Card>
  );
}

function Unbilled({ o }: { o: MoneyOverview }) {
  return (
    <Card title={t('money.home.notInvoiced')} subtitle={t('money.home.notInvoicedSub')}>
      {o.unbilled.length === 0 ? (
        <Empty title={t('money.home.allInvoiced')} />
      ) : (
        <TableBox label={t('money.home.notInvoicedTable')}>
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">{t('money.col.client')}</th>
                <th scope="col">{t('money.col.since')}</th>
                <th scope="col" className={numClass}>
                  {t('money.col.recorded')}
                </th>
                <th scope="col">
                  <span className="visually-hidden">{t('money.col.action')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {o.unbilled.map((u) => (
                <tr key={u.client_id}>
                  <th scope="row">{u.client_name}</th>
                  <td className="small">{formatDayMonth(u.since)}</td>
                  <td className={numClass}>{formatDuration(u.seconds)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Link href={`/admin/invoices?client=${u.client_id}&from=${u.since}`}>{t('money.home.draftInvoice')}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
    </Card>
  );
}

function Budgets({ o }: { o: MoneyOverview }) {
  if (o.budgets.length === 0) return null;
  return (
    <Card title={t('money.home.budgets')} subtitle={t('money.home.budgetsSub')} actions={<Link href="/admin/rates">{t('money.home.ratesLink')}</Link>}>
      {o.budgets.map((b) => (
        <div key={b.project_id}>
          <strong>{b.project_name}</strong>
          <BudgetMeter budget={b} />
        </div>
      ))}
    </Card>
  );
}

/** Finance home (G21–G23): close the pay period, get invoices out and paid, watch budgets. */
function PeriodClose() {
  const { timezone: tz } = useMe();
  const today = todayInTz(tz);
  const overview = useApi('money:overview', (signal) => rd.money.overview(signal));
  return (
    <>
      <PageHeader
        eyebrow={t('money.home.eyebrow')}
        title={t('money.home.title')}
        description={t('money.home.description')}
      />
      <Resource {...overview} label={t('money.home.loading')}>
        {(o) => {
          const unpaid = o.open_invoices.filter((i) => i.status === 'issued');
          const overdue = unpaid.filter((i) => invoiceState(i, today) === 'overdue');
          const drafts = o.open_invoices.filter((i) => i.status === 'draft');
          const ts = o.timesheets;
          return (
            <>
              <Tiles
                label={t('money.home.payPeriod', { from: formatDayMonth(o.period.from), to: formatDayMonth(o.period.to) })}
                tiles={[
                  ts
                    ? {
                        label: t('money.home.approved'),
                        value: formatDuration(ts.approved_seconds),
                        sub: tPlural(ts.approved, 'money.home.approvedSub.one', 'money.home.approvedSub.other', { waiting: ts.submitted, back: ts.sent_back }),
                        alert: ts.submitted + ts.sent_back > 0,
                      }
                    : { label: t('money.home.approved'), value: '—', sub: t('money.home.timesheetsPlan') },
                  {
                    label: t('money.home.unpaid'),
                    value: unpaid.length,
                    sub: overdue.length ? t('money.home.overdue', { n: overdue.length, amounts: moneyList(totalsByCurrency(unpaid)) }) : moneyList(totalsByCurrency(unpaid)),
                    alert: overdue.length > 0,
                  },
                  { label: t('money.home.drafts'), value: drafts.length, sub: drafts.length ? moneyList(totalsByCurrency(drafts)) : t('money.home.none') },
                  { label: t('money.home.paid'), value: o.paid_this_period.count, sub: moneyList(o.paid_this_period.by_currency) },
                ]}
              />
              <OpenInvoices o={o} today={today} />
              <Payroll tz={tz} today={today} />
              <Unbilled o={o} />
              <Budgets o={o} />
            </>
          );
        }}
      </Resource>
    </>
  );
}

export default function MoneyHome() {
  return (
    <MoneyGate title={t('money.home.title')}>
      <PeriodClose />
    </MoneyGate>
  );
}
