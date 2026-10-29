'use client';

import Link from 'next/link';
import type { MoneyOverview } from '@rd/contracts';
import { BudgetMeter } from '@/components/BudgetMeter';
import { Payroll } from '@/components/money/Payroll';
import { Empty, Resource } from '@/components/ui/DataState';
import { Badge, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { Tiles } from '@/components/workspace/Tiles';
import { rd } from '@/lib/api';
import { formatDuration, formatMoney, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDayMonth, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { INVOICE_STATE_LABEL, invoiceState, totalsByCurrency } from '@/lib/workspaces';
import { MoneyGate } from '../admin/MoneyGate';

const moneyList = (rows: readonly { currency: string; total_cents: number }[]) =>
  rows.length ? rows.map((r) => formatMoney(r.total_cents, r.currency)).join(' · ') : '—';

function OpenInvoices({ o, today }: { o: MoneyOverview; today: string }) {
  return (
    <Card title="Invoices to finish" subtitle="Drafts to issue and issued invoices not yet paid, oldest first" actions={<Link href="/admin/invoices">All invoices →</Link>}>
      {o.open_invoices.length === 0 ? (
        <Empty title="Nothing outstanding">Every issued invoice is marked paid.</Empty>
      ) : (
        <TableBox label="Open invoices">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Client</th>
                <th scope="col">Period</th>
                <th scope="col">Due</th>
                <th scope="col">State</th>
                <th scope="col" className={numClass}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {o.open_invoices.map((i) => {
                const state = invoiceState(i, today);
                return (
                  <tr key={i.id}>
                    <th scope="row">
                      <Link href={`/admin/invoices/${i.id}`}>{i.number ?? 'Draft'}</Link>
                    </th>
                    <td>{i.client_name}</td>
                    <td className="small">
                      {formatDayMonth(i.period_from)} – {formatDayMonth(i.period_to)}
                    </td>
                    <td className="small">{i.due_date ? formatDayMonth(i.due_date) : '—'}</td>
                    <td>
                      <Badge tone={state === 'overdue' ? 'warn' : 'outline'}>{INVOICE_STATE_LABEL[state]}</Badge>
                      {i.sent_at ? <span className="small muted"> Sent</span> : null}
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
    <Card title="Not yet invoiced" subtitle="Recorded time on each client's projects since its last issued invoice (up to 90 days back)">
      {o.unbilled.length === 0 ? (
        <Empty title="Everything recorded has been invoiced" />
      ) : (
        <TableBox label="Time not yet invoiced">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Since</th>
                <th scope="col" className={numClass}>
                  Recorded time
                </th>
                <th scope="col">
                  <span className="visually-hidden">Action</span>
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
                    <Link href={`/admin/invoices?client=${u.client_id}&from=${u.since}`}>Draft an invoice →</Link>
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
    <Card title="Budgets near or over" subtitle="Projects at 80% of their budget or more" actions={<Link href="/admin/rates">Rates and budgets →</Link>}>
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
        eyebrow="Finance · Home"
        title="Period close"
        description="This pay period's hours, payroll, invoices to finish and time not yet billed. Amounts are never added across currencies."
      />
      <Resource {...overview} label="Loading the period">
        {(o) => {
          const unpaid = o.open_invoices.filter((i) => i.status === 'issued');
          const overdue = unpaid.filter((i) => invoiceState(i, today) === 'overdue');
          const drafts = o.open_invoices.filter((i) => i.status === 'draft');
          const t = o.timesheets;
          return (
            <>
              <Tiles
                label={`Pay period ${formatDayMonth(o.period.from)} – ${formatDayMonth(o.period.to)}`}
                tiles={[
                  t
                    ? {
                        label: 'Approved this month',
                        value: formatDuration(t.approved_seconds),
                        sub: `${plural(t.approved, 'week')} approved · ${t.submitted} waiting · ${t.sent_back} sent back`,
                        alert: t.submitted + t.sent_back > 0,
                      }
                    : { label: 'Approved this month', value: '—', sub: 'Timesheets are part of Standard and Pro' },
                  {
                    label: 'Unpaid invoices',
                    value: unpaid.length,
                    sub: overdue.length ? `${overdue.length} overdue · ${moneyList(totalsByCurrency(unpaid))}` : moneyList(totalsByCurrency(unpaid)),
                    alert: overdue.length > 0,
                  },
                  { label: 'Drafts to issue', value: drafts.length, sub: drafts.length ? moneyList(totalsByCurrency(drafts)) : 'None' },
                  { label: 'Paid this month', value: o.paid_this_period.count, sub: moneyList(o.paid_this_period.by_currency) },
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
    <MoneyGate title="Period close">
      <PeriodClose />
    </MoneyGate>
  );
}
