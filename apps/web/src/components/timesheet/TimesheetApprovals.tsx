'use client';

import Link from 'next/link';
import type { TimesheetDTO } from '@rd/contracts';
import { Empty, Resource } from '@/components/ui/DataState';
import { Banner, Card } from '@/components/ui/Layout';
import { formatDuration, plural } from '@/lib/format';
import { addDays, formatDateTime, formatDayMonth } from '@/lib/time';
import { limitsSummary, timesheetsApi } from '@/lib/timesheets';
import { useApi } from '@/lib/useApi';
import { ReviewPanel, TimesheetGrid, TimesheetTiles, memberTimesheetHref } from './TimesheetView';

function weekText(periodStart: string): string {
  return `${formatDayMonth(periodStart)} – ${formatDayMonth(addDays(periodStart, 6))}`;
}

function PendingSheet({ t, tz, onDone }: { t: TimesheetDTO; tz: string; onDone: (id: string) => void }) {
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

/** Timesheets waiting for the signed-in reviewer (team managers; org admins see everyone's). */
export function TimesheetApprovals({ tz }: { tz: string }) {
  const pending = useApi('timesheets:pending', (signal) => timesheetsApi.pending(signal));
  return (
    <>
      <h2>Timesheets</h2>
      <Resource {...pending} label="Loading submitted timesheets">
        {(list) =>
          list.length === 0 ? (
            <Card>
              <Empty title="No timesheets to review">Submitted weeks appear here. Approving one locks that week for payroll.</Empty>
            </Card>
          ) : (
            <>
              <p className="secondary">{plural(list.length, 'timesheet')} waiting, oldest first. Totals shown are as submitted.</p>
              {list.map((t) => (
                <PendingSheet
                  key={t.id}
                  t={t}
                  tz={tz}
                  onDone={(id) => pending.mutate((prev) => prev?.filter((x) => x.id !== id))}
                />
              ))}
            </>
          )
        }
      </Resource>
    </>
  );
}
