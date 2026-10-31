'use client';

import Link from 'next/link';
import type { TimesheetDTO } from '@rd/contracts';
import { Banner, Card } from '@/components/ui/Layout';
import { formatDuration } from '@/lib/format';
import { t } from '@/lib/i18n';
import { addDays, formatDateTime, formatDayMonth } from '@/lib/time';
import { limitsSummary } from '@/lib/timesheets';
import { ReviewPanel, TimesheetGrid, TimesheetTiles, memberTimesheetHref } from './TimesheetView';

const weekOf = (periodStart: string) => ({ from: formatDayMonth(periodStart), to: formatDayMonth(addDays(periodStart, 6)) });

/** One submitted week, reviewed on its own (detail panel of the approvals inbox). */
export function TimesheetReviewCard({ sheet, tz, onDone }: { sheet: TimesheetDTO; tz: string; onDone: (id: string) => void }) {
  // What the employee submitted is the original; current figures are shown if they moved since.
  const original = sheet.submitted_totals ?? sheet.totals;
  const last = sheet.events[sheet.events.length - 1];
  return (
    <Card
      title={t('mgr.tsr.title', { name: sheet.user_name, ...weekOf(sheet.period_start) })}
      subtitle={t('ts.submittedAt', { when: formatDateTime(sheet.submitted_at, tz) })}
      actions={<Link href={memberTimesheetHref(sheet.user_id, sheet.period_start, { name: sheet.user_name })}>{t('mgr.tsr.openWeek')}</Link>}
    >
      {sheet.changed_since_submit ? (
        <Banner tag={t('mgr.tsr.changedTag')}>
          {t('mgr.tsr.changed', { submitted: formatDuration(original.total_seconds), now: formatDuration(sheet.totals.total_seconds) })}
        </Banner>
      ) : null}
      {last && last.action === 'submit' && last.note ? (
        <p>
          <span className="label-mono">{t('mgr.tsr.noteFrom', { name: sheet.user_name })}</span>
          <br />“{last.note}”
        </p>
      ) : null}
      <TimesheetTiles totals={original} limitsText={limitsSummary(sheet.limits)} />
      <TimesheetGrid totals={original} label={t('mgr.tsr.gridLabel', { name: sheet.user_name, ...weekOf(sheet.period_start) })} />
      <ReviewPanel sheet={sheet} onDone={() => onDone(sheet.id!)} />
    </Card>
  );
}
