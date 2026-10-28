'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { formatPercentBp } from '@/lib/money';
import { formatDayLabel } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import s from './print.module.css';

/**
 * Printable invoice, outside the app shell so nothing but the invoice prints. "Save as
 * PDF" in the browser's print dialog produces the PDF — no PDF library needed. The API
 * call is admin-only; signed-out visitors are sent to sign in.
 */
export default function PrintInvoicePage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? '');
  const res = useApi(id ? `print:invoice|${id}` : null, (signal) => rd.money.invoice(id, signal));

  if (res.error)
    return (
      <main className={s.page}>
        <ErrorState error={res.error} onRetry={res.reload} />
      </main>
    );
  if (!res.data)
    return (
      <main className={s.page}>
        <Loading label="Loading the invoice" />
      </main>
    );
  const inv = res.data;
  const day = (d: string | null) => (d ? formatDayLabel(d) : '—');
  const issuedDay = inv.issued_at ? inv.issued_at.slice(0, 10) : null;

  return (
    <main className={s.page}>
      <div className={s.toolbar}>
        <Link href={`/admin/invoices/${inv.id}`}>← Back to the invoice</Link>
        <Button variant="primary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <article className={s.sheet} aria-label={`Invoice ${inv.number ?? 'draft'}`}>
        <header className={s.head}>
          <div>
            <span className={s.label}>{inv.organization_name}</span>
            <h1 className={s.title}>{inv.number ? `Invoice ${inv.number}` : 'Draft invoice'}</h1>
          </div>
          <dl className={s.meta}>
            <dt>Issued</dt>
            <dd>{day(issuedDay)}</dd>
            <dt>Due</dt>
            <dd>{day(inv.due_date)}</dd>
            <dt>Period</dt>
            <dd>
              {day(inv.period_from)} – {day(inv.period_to)}
            </dd>
            <dt>Currency</dt>
            <dd>{inv.currency}</dd>
          </dl>
        </header>
        {inv.status !== 'issued' ? <span className={s.stamp}>{inv.status === 'void' ? 'Void' : 'Draft — not issued'}</span> : null}
        <section className={s.parties}>
          <div>
            <span className={s.label}>Bill to</span>
            <strong>{inv.client.name}</strong>
            {inv.client.address ? <div className={s.address}>{inv.client.address}</div> : null}
            {inv.client.contact_email ? <div>{inv.client.contact_email}</div> : null}
          </div>
          <div>
            <span className={s.label}>From</span>
            <strong>{inv.organization_name}</strong>
          </div>
        </section>
        <table className={s.lines}>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className={s.num}>
                Hours
              </th>
              <th scope="col" className={s.num}>
                Rate
              </th>
              <th scope="col" className={s.num}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className={s.num}>{l.hours.toFixed(2)}</td>
                <td className={s.num}>{formatMoney(l.rate_cents, inv.currency)}</td>
                <td className={s.num}>{formatMoney(l.amount_cents, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className={s.totals}>
          <dt>Subtotal</dt>
          <dd>{formatMoney(inv.subtotal_cents, inv.currency)}</dd>
          <dt>Tax ({formatPercentBp(inv.tax_rate_bp)})</dt>
          <dd>{formatMoney(inv.tax_cents, inv.currency)}</dd>
          <dt className={s.grand}>Total due</dt>
          <dd className={s.grand}>{formatMoney(inv.total_cents, inv.currency)}</dd>
        </dl>
        {inv.notes ? <p className={s.notes}>{inv.notes}</p> : null}
      </article>
    </main>
  );
}
