'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { InvoiceSheet, invoiceSheetStyles as s } from '@/components/money/InvoiceSheet';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { useApi } from '@/lib/useApi';

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

  return (
    <main className={s.page}>
      <div className={s.toolbar}>
        <Link href={`/admin/invoices/${inv.id}`}>← Back to the invoice</Link>
        <Button variant="primary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <InvoiceSheet inv={inv} />
    </main>
  );
}
