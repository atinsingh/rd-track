'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { InvoiceSheet, invoiceSheetStyles as sheet } from '@/components/money/InvoiceSheet';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { clientPortal } from '@/lib/portal';
import { useApi } from '@/lib/useApi';

/** One of the client's issued invoices, printable like the agency's copy (Stage 4 F9). */
export default function ClientInvoicePage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? '');
  const res = useApi(id ? `client:invoice|${id}` : null, (signal) => clientPortal.invoice(id, signal));
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Loading the invoice" />;
  return (
    <>
      <div className={sheet.toolbar}>
        <Link href="/client">← Back to your projects</Link>
        <Button variant="primary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <InvoiceSheet inv={res.data} />
    </>
  );
}
