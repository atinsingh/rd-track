'use client';

import type { ClientPortalInvoice } from '@rd/contracts';
import { OrgLogo } from '@/components/OrgLogo';
import { formatMoney, formatNumber, formatPercent } from '@/lib/format';
import { tFor } from '@/lib/i18n';
import { currentLocale } from '@/lib/locale';
import s from './invoiceSheet.module.css';

export { s as invoiceSheetStyles };

/**
 * An invoice as the client receives it: the print page and the client portal (F9) both show
 * this. It is the agency's document, so it is in the agency's language and formats (G27),
 * whoever opens it; without one set, in the reader's.
 */
export function InvoiceSheet({ inv }: { inv: ClientPortalInvoice }) {
  const locale = inv.organization_locale ?? currentLocale();
  const t = tFor(locale);
  const money = (cents: number) => formatMoney(cents, inv.currency, locale);
  const dayFmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const day = (d: string | null) => (d ? dayFmt.format(new Date(`${d}T12:00:00Z`)) : '—');
  const issuedDay = inv.issued_at ? inv.issued_at.slice(0, 10) : null;
  return (
    <article className={s.sheet} lang={locale} aria-label={inv.number ? t('invoice.number', { number: inv.number }) : t('invoice.draft')}>
      <header className={s.head}>
        <div>
          <OrgLogo url={inv.organization_logo_url ?? null} name={inv.organization_name} plain />
          <span className={s.label}>{inv.organization_name}</span>
          <h1 className={s.title}>{inv.number ? t('invoice.number', { number: inv.number }) : t('invoice.draft')}</h1>
        </div>
        <dl className={s.meta}>
          <dt>{t('invoice.issued')}</dt>
          <dd>{day(issuedDay)}</dd>
          <dt>{t('invoice.due')}</dt>
          <dd>{day(inv.due_date)}</dd>
          <dt>{t('invoice.period')}</dt>
          <dd>
            {day(inv.period_from)} – {day(inv.period_to)}
          </dd>
          <dt>{t('invoice.currency')}</dt>
          <dd>{inv.currency}</dd>
        </dl>
      </header>
      {inv.status !== 'issued' ? <span className={s.stamp}>{inv.status === 'void' ? t('invoice.void') : t('invoice.notIssued')}</span> : null}
      <section className={s.parties}>
        <div>
          <span className={s.label}>{t('invoice.billTo')}</span>
          <strong>{inv.client.name}</strong>
          {inv.client.address ? <div className={s.address}>{inv.client.address}</div> : null}
          {inv.client.contact_email ? <div>{inv.client.contact_email}</div> : null}
        </div>
        <div>
          <span className={s.label}>{t('invoice.from')}</span>
          <strong>{inv.organization_name}</strong>
        </div>
      </section>
      <table className={s.lines}>
        <thead>
          <tr>
            <th scope="col">{t('invoice.description')}</th>
            <th scope="col" className={s.num}>
              {t('invoice.hours')}
            </th>
            <th scope="col" className={s.num}>
              {t('invoice.rate')}
            </th>
            <th scope="col" className={s.num}>
              {t('invoice.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className={s.num}>{formatNumber(l.hours, 2, locale)}</td>
              <td className={s.num}>{money(l.rate_cents)}</td>
              <td className={s.num}>{money(l.amount_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className={s.totals}>
        <dt>{t('invoice.subtotal')}</dt>
        <dd>{money(inv.subtotal_cents)}</dd>
        <dt>{t('invoice.tax', { rate: formatPercent(inv.tax_rate_bp / 100, inv.tax_rate_bp % 100 === 0 ? 0 : 2, locale) })}</dt>
        <dd>{money(inv.tax_cents)}</dd>
        <dt className={s.grand}>{t('invoice.total')}</dt>
        <dd className={s.grand}>{money(inv.total_cents)}</dd>
      </dl>
      {inv.notes ? <p className={s.notes}>{inv.notes}</p> : null}
    </article>
  );
}
