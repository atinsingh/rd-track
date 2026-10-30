'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { AgainstExpected, Days, Summary, Wellbeing, WorkApps } from '@/components/insights/Sections';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { ApiError, rd } from '@/lib/api';
import { t } from '@/lib/i18n';
import { announceLocale, resolveLocale, setLocale } from '@/lib/locale';
import { addDays, daysRange, formatDayLabel, isValidTimeZone } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import s from './print.module.css';

/**
 * My insights as a printable sheet (Stage 4 F9), outside the app shell like the invoice:
 * "Save as PDF" in the print dialog makes the PDF. It only ever shows the signed-in
 * person's own insights, and nothing is sent anywhere.
 */
function PrintInsights() {
  const q = useSearchParams();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(q.get('start') ?? '') ? q.get('start')! : null;
  const days = q.get('days') === '28' ? 28 : 7;
  const tzParam = q.get('tz') ?? 'UTC';
  const tz = isValidTimeZone(tzParam) ? tzParam : 'UTC';
  const range = start ? daysRange(start, days, tz) : null;
  const me = useApi('print:me', (signal) => rd.me({ signal }));
  const res = useApi(range ? `print:insights|${range.from}|${range.to}|${tz}` : null, (signal) => rd.my.insights(range!, tz, signal));
  // Outside the app shell, so set the person's language and formats here (G27).
  const locale = me.data ? resolveLocale(me.data.user.locale, me.data.organization.locale) : null;
  if (locale) setLocale(locale, false);
  useEffect(() => {
    if (locale) announceLocale();
  }, [locale]);

  if (!start) return <ErrorState error={new ApiError(400, 'validation_failed', t('ins.missingPeriod'), null)} />;
  const error = res.error ?? me.error;
  if (error) return <ErrorState error={error} onRetry={() => (res.reload(), me.reload())} />;
  if (!res.data || !me.data) return <Loading label={t('ins.loading')} />;
  const d = res.data;
  return (
    <>
      <div className={s.toolbar}>
        <Link href="/me/insights">{t('ins.back')}</Link>
        <Button variant="primary" onClick={() => window.print()}>
          {t('ins.print')}
        </Button>
      </div>
      <article className={s.sheet} aria-label={t('ins.title')}>
        <header className={s.head}>
          <div>
            <span className={s.label}>{me.data.organization.name} · RoundDigital Track</span>
            <h1 className={s.title}>{t('ins.sheetTitle', { name: me.data.user.display_name })}</h1>
          </div>
          <dl className={s.meta}>
            <dt>{t('ins.printPeriod')}</dt>
            <dd>
              {formatDayLabel(start)} – {formatDayLabel(addDays(start, days - 1))}
            </dd>
            <dt>{t('ins.printTz')}</dt>
            <dd>{tz}</dd>
          </dl>
        </header>
        <p className={s.note}>{t('ins.printNote')}</p>
        <Wellbeing d={d} />
        <Summary d={d} />
        <AgainstExpected d={d} byWeek={days !== 7} />
        <WorkApps d={d} />
        <Days d={d} />
      </article>
    </>
  );
}

export default function PrintInsightsPage() {
  return (
    <main className={s.page}>
      <Suspense fallback={<Loading label={t('common.loading')} />}>
        <PrintInsights />
      </Suspense>
    </main>
  );
}
