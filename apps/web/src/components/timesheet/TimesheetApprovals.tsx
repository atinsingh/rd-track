'use client';

import Link from 'next/link';
import type { TimesheetDTO } from '@rd/contracts';
import { Banner, Card } from '@/components/ui/Layout';
import { formatDuration } from '@/lib/format';
import { addDays, formatDateTime, formatDayMonth } from '@/lib/time';
import { limitsSummary } from '@/lib/timesheets';
import { ReviewPanel, TimesheetGrid, TimesheetTiles, memberTimesheetHref } from './TimesheetView';

function weekText(periodStart: string): string {
  return `${formatDayMonth(periodStart)} – ${formatDayMonth(addDays(periodStart, 6))}`;
}

/** One submitted week, reviewed on its own (detail panel of the approvals inbox). */
export function TimesheetReviewCard({ t, tz, onDone }: { t: TimesheetDTO; tz: string; onDone: (id: string) => void }) {
  // What the employee submitted is the original; current figures are shown if they moved since.
  const original = t.submitted_totals ?? t.totals;
  return (
    <Card
      title={`${t.user_name} · Week of ${weekText(t.period_start)}`}
      subtitle={`Submitted ${formatDateTime(t.submitted_at, tz)}`}
      actions={<Link href={memberTimesheetHref(t.user_id, t.period_start, { name: t.user_name })}>Open week →</Link>}
    >
      {t.changed_since_submit ? (
        <Banner tag="CHANGED">
          The records changed after submission: submitted {formatDuration(original.total_seconds)}, now{' '}
          {formatDuration(t.totals.total_seconds)}. Approving freezes the current figures.
        </Banner>
      ) : null}
      {t.events.length > 0 && t.events[t.events.length - 1]!.action === 'submit' && t.events[t.events.length - 1]!.note ? (
        <p>
          <span className="label-mono">Note from {t.user_name}</span>
          <br />“{t.events[t.events.length - 1]!.note}”
        </p>
      ) : null}
      <TimesheetTiles totals={original} limitsText={limitsSummary(t.limits)} />
      <TimesheetGrid totals={original} label={`Submitted timesheet, ${t.user_name}, week of ${weekText(t.period_start)}`} />
      <ReviewPanel sheet={t} onDone={() => onDone(t.id!)} />
    </Card>
  );
}
