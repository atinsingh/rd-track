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
import { invoiceStateLabel, parsePercentBp } from '@/lib/money';
import { addDays, formatDayLabel, startOfMonth, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { invoiceState } from '@/lib/workspaces';
import { t } from '@/lib/i18n';
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
    <Card title={t('money.inv.newDraft')}>
      {clients.data && active.length === 0 ? (
        <Banner tag="NOTE">
          {t('money.inv.noClients')} <Link href="/admin/clients">{t('money.inv.clientsLink')}</Link>.
        </Banner>
      ) : null}
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField
            label={t('money.inv.client')}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            hint={client ? t('money.inv.billedIn', { currency: client.currency }) : undefined}
          >
            <option value="">{t('money.inv.chooseClient')}</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <TextField label={t('money.inv.periodFrom')} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField
            label={t('money.inv.to')}
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            hint={t('money.inv.wholeDays', { tz })}
            error={from > to ? t('money.payroll.endBefore') : null}
          />
          <SelectField label={t('money.inv.lines')} value={groupBy} onChange={(e) => setGroupBy(e.target.value as InvoiceGrouping)}>
            <option value="project">{t('money.inv.perProject')}</option>
            <option value="project_person">{t('money.inv.perProjectPerson')}</option>
          </SelectField>
          <TextField
            label={t('money.inv.taxRate')}
            inputMode="decimal"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            error={taxBp === null ? t('money.inv.taxInvalid') : null}
          />
        </div>
        <p className="small muted">{t('money.inv.howBuilt')}</p>
        <ActionError error={create.error} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={!clientId || from > to || taxBp === null || create.busy}>
            {create.busy ? t('money.inv.building') : t('money.inv.build')}
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
        eyebrow={t('money.inv.eyebrow')}
        title={t('money.inv.title')}
        description={t('money.inv.description')}
      />
      <NewDraft />
      <Card title={t('money.inv.all')}>
        <Resource {...invoices} label={t('money.inv.loading')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('money.inv.none')} />
            ) : (
              <TableBox label={t('money.inv.table')}>
                <table className={tableClass} style={{ minWidth: 680 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('money.col.invoice')}</th>
                      <th scope="col">{t('money.col.client')}</th>
                      <th scope="col">{t('money.col.period')}</th>
                      <th scope="col">{t('money.inv.status')}</th>
                      <th scope="col" className={numClass}>
                        {t('money.col.total')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <Link href={`/admin/invoices/${i.id}`}>{i.number ?? t('money.draft')}</Link>
                        </td>
                        <td>{i.client_name}</td>
                        <td>
                          {formatDayLabel(i.period_from)} – {formatDayLabel(i.period_to)}
                        </td>
                        <td>
                          <Badge tone={invoiceState(i, today) === 'overdue' ? 'warn' : i.status === 'issued' ? 'solid' : 'outline'}>
                            {invoiceStateLabel(invoiceState(i, today))}
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
    <MoneyGate title={t('money.inv.title')}>
      <InvoicesContent />
    </MoneyGate>
  );
}
