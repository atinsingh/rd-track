'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { InvoiceGrouping } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useMe } from '@/lib/me';
import { parsePercentBp } from '@/lib/money';
import { addDays, formatDayLabel, startOfMonth, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { INVOICE_STATE_LABEL, invoiceState } from '@/lib/workspaces';
import { MoneyGate } from '../MoneyGate';
import m from '../money.module.css';

function NewDraft() {
  const router = useRouter();
  const { timezone: tz } = useMe();
  const today = todayInTz(tz);
  const clients = useApi('money:clients', (signal) => rd.money.clients(signal));
  const create = useAction();
  // ?client=&from= comes from "Not yet invoiced" on Period close.
  const params = useSearchParams();
  const qFrom = params.get('from');
  const fromParam = qFrom && /^\d{4}-\d{2}-\d{2}$/.test(qFrom) && qFrom <= today ? qFrom : null;
  const [clientId, setClientId] = useState(() => params.get('client') ?? '');
  const [from, setFrom] = useState(() => fromParam ?? startOfMonth(addDays(startOfMonth(today), -1)));
  const [to, setTo] = useState(() => (fromParam ? today : addDays(startOfMonth(today), -1)));
  const [groupBy, setGroupBy] = useState<InvoiceGrouping>('project');
  const [tax, setTax] = useState('0');
  const taxBp = parsePercentBp(tax);
  const active = (clients.data ?? []).filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  const client = active.find((c) => c.id === clientId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!clientId || from > to || taxBp === null) return;
    const r = await create.run(() =>
      rd.money.createInvoice({ client_id: clientId, period_from: from, period_to: to, timezone: tz, group_by: groupBy, tax_rate_bp: taxBp }),
    );
    if (r) router.push(`/admin/invoices/${r.id}`);
  };

  return (
    <Card title="New draft invoice">
      {clients.data && active.length === 0 ? (
        <Banner tag="NOTE">
          Create a client and assign its projects first, in <Link href="/admin/clients">Clients</Link>.
        </Banner>
      ) : null}
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)} hint={client ? `Billed in ${client.currency}` : undefined}>
            <option value="">Choose a client…</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <TextField label="Period from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            hint={`Whole days in ${tz}`}
            error={from > to ? 'The end date is before the start date.' : null}
          />
          <SelectField label="Lines" value={groupBy} onChange={(e) => setGroupBy(e.target.value as InvoiceGrouping)}>
            <option value="project">One per project</option>
            <option value="project_person">One per project and person</option>
          </SelectField>
          <TextField
            label="Tax rate (%)"
            inputMode="decimal"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            error={taxBp === null ? 'Enter a percentage between 0 and 100' : null}
          />
        </div>
        <p className="small muted">
          Lines use each project&apos;s bill rate in effect on the day a session started. Hours are rounded to the minute, then to two decimals. You can edit
          every line before issuing.
        </p>
        <ActionError error={create.error} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={!clientId || from > to || taxBp === null || create.busy}>
            {create.busy ? 'Building…' : 'Build draft →'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function InvoicesContent() {
  const { timezone: tz } = useMe();
  const today = todayInTz(tz);
  const invoices = useApi('money:invoices', (signal) => rd.money.invoices(signal));
  return (
    <>
      <PageHeader
        eyebrow="Admin · Money"
        title="Invoices"
        description="Build invoices from time recorded on a client's projects. Issuing gives the invoice its number and locks it; an issued invoice can only be voided."
      />
      <NewDraft />
      <Card title="All invoices">
        <Resource {...invoices} label="Loading invoices">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No invoices yet" />
            ) : (
              <TableBox label="Invoices">
                <table className={tableClass} style={{ minWidth: 680 }}>
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th>
                      <th scope="col">Client</th>
                      <th scope="col">Period</th>
                      <th scope="col">Status</th>
                      <th scope="col" className={numClass}>
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <Link href={`/admin/invoices/${i.id}`}>{i.number ?? 'Draft'}</Link>
                        </td>
                        <td>{i.client_name}</td>
                        <td>
                          {formatDayLabel(i.period_from)} – {formatDayLabel(i.period_to)}
                        </td>
                        <td>
                          <Badge tone={invoiceState(i, today) === 'overdue' ? 'warn' : i.status === 'issued' ? 'solid' : 'outline'}>
                            {INVOICE_STATE_LABEL[invoiceState(i, today)]}
                          </Badge>
                        </td>
                        <td className={numClass}>{formatMoney(i.total_cents, i.currency)}</td>
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

export default function InvoicesPage() {
  return (
    <MoneyGate title="Invoices">
      <InvoicesContent />
    </MoneyGate>
  );
}
