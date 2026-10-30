'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { InvoiceSheet, invoiceSheetStyles as s } from '@/components/money/InvoiceSheet';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { t } from '@/lib/i18n';
import { announceLocale, resolveLocale, setLocale } from '@/lib/locale';
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
  // Outside the app shell, so the toolbar takes the reader's language here (G27); the sheet keeps the invoice's own.
  const me = useApi('print:me', (signal) => rd.me({ signal }));
  const locale = me.data ? resolveLocale(me.data.user.locale, me.data.organization.locale) : null;
  if (locale) setLocale(locale, false);
  useEffect(() => {
    if (locale) announceLocale();
  }, [locale]);

  if (res.error)
    return (
      <main className={s.page}>
        <ErrorState error={res.error} onRetry={res.reload} />
      </main>
    );
  if (!res.data)
    return (
      <main className={s.page}>
        <Loading label={t('money.print.loading')} />
      </main>
    );
  const inv = res.data;

  return (
    <main className={s.page}>
      <div className={s.toolbar}>
        <Link href={`/admin/invoices/${inv.id}`}>{t('money.print.back')}</Link>
        <Button variant="primary" onClick={() => window.print()}>
          {t('money.print.print')}
        </Button>
      </div>
      <InvoiceSheet inv={inv} />
    </main>
  );
}
