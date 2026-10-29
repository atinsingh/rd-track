'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AgainstExpected, Days, Summary, Wellbeing, WorkApps } from '@/components/insights/Sections';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { ApiError, rd } from '@/lib/api';
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

  if (!start) return <ErrorState error={new ApiError(400, 'validation_failed', 'This link is missing its period. Open it again from Insights.', null)} />;
  const error = res.error ?? me.error;
  if (error) return <ErrorState error={error} onRetry={() => (res.reload(), me.reload())} />;
  if (!res.data || !me.data) return <Loading label="Working out your insights" />;
  const d = res.data;
  return (
    <>
      <div className={s.toolbar}>
        <Link href="/me/insights">← Back to Insights</Link>
        <Button variant="primary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <article className={s.sheet} aria-label="Insights">
        <header className={s.head}>
          <div>
            <span className={s.label}>{me.data.organization.name} · RoundDigital Track</span>
            <h1 className={s.title}>Insights · {me.data.user.display_name}</h1>
          </div>
          <dl className={s.meta}>
            <dt>Period</dt>
            <dd>
              {formatDayLabel(start)} – {formatDayLabel(addDays(start, days - 1))}
            </dd>
            <dt>Time zone</dt>
            <dd>{tz}</dd>
          </dl>
        </header>
        <p className={s.note}>
          Worked out from your own activity and visible to you only. A focus block is 30 minutes or more of continuous activity in one session.
          Computer activity is not a measure of performance.
        </p>
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
      <Suspense fallback={<Loading label="Loading" />}>
        <PrintInsights />
      </Suspense>
    </main>
  );
}
