'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { TimesheetDTO, TimesheetEventDTO, TimesheetTotals } from '@rd/contracts';
import d from '@/components/day/day.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty } from '@/components/ui/DataState';
import { TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, TableBox, formActionsClass, numClass, tableClass } from '@/components/ui/Layout';
import { cx } from '@/lib/cx';
import { durationOrDash, formatDuration } from '@/lib/format';
import { formatDateTime, formatDayMonth, weekdayShort } from '@/lib/time';
import { STATUS_LABEL, countedTotals, limitsSummary, overtimeText, reviewActions, statusTone, timesheetGrid, timesheetsApi } from '@/lib/timesheets';
import { useAction } from '@/lib/useApi';
import s from './timesheet.module.css';

export function StatusBadge({ status }: { status: TimesheetDTO['status'] }) {
  return <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>;
}

/** Tracked / manual / corrected / over-limit tiles for a week. */
export function TimesheetTiles({ totals, limitsText }: { totals: TimesheetTotals; limitsText: string }) {
  return (
    <section aria-label="Week summary" className={d.tiles}>
      <div className={d.tile}>
        <span className={d.tileLabel}>Total</span>
        <span className={d.tileValue}>{formatDuration(totals.total_seconds)}</span>
        <span className={d.tileSub}>Sessions that started this week</span>
      </div>
      <div className={d.tile}>
        <span className={d.tileLabel}>Tracked by agent</span>
        <span className={d.tileValue}>{formatDuration(totals.tracked_seconds)}</span>
        <span className={d.tileSub}>Measured on the computer</span>
      </div>
      <div className={d.tile}>
        <span className={d.tileLabel}>Manual and corrected</span>
        <span className={d.tileValue}>{formatDuration(totals.manual_seconds + totals.corrected_seconds)}</span>
        <span className={d.tileSub}>
          Approved entries · manual {durationOrDash(totals.manual_seconds)} · corrected {durationOrDash(totals.corrected_seconds)}
        </span>
      </div>
      <div className={d.tile}>
        <span className={d.tileLabel}>Over limit</span>
        <span className={d.tileValue}>{totals.overtime_seconds > 0 ? formatDuration(totals.overtime_seconds) : '—'}</span>
        <span className={d.tileSub}>{limitsText}</span>
      </div>
    </section>
  );
}

/** Project × day grid with daily totals and time over the daily limit. */
export function TimesheetGrid({ totals, label }: { totals: TimesheetTotals; label: string }) {
  const rows = timesheetGrid(totals);
  if (rows.length === 0) return <Empty title="No time recorded this week">Sessions and approved manual time appear here.</Empty>;
  const hasOver = totals.days.some((x) => x.overtime_seconds > 0) || totals.weekly_overtime_seconds > 0;
  return (
    <TableBox label={label}>
      <table className={cx(tableClass, s.grid)} style={{ minWidth: 820 }}>
        <caption className="visually-hidden">{label}: hours per project and day</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            {totals.days.map((day, i) => (
              <th key={day.date} scope="col" className={cx(numClass, i >= 5 && s.weekend)}>
                {weekdayShort(i + 1)} {formatDayMonth(day.date)}
              </th>
            ))}
            <th scope="col" className={numClass}>
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className={s.rowHead}>
                {r.name}
              </th>
              {r.days.map((sec, i) => (
                <td key={i} className={cx(numClass, i >= 5 && s.weekend)}>
                  {durationOrDash(sec)}
                </td>
              ))}
              <td className={numClass}>{formatDuration(r.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className={s.rowHead}>
              Day total
            </th>
            {totals.days.map((day, i) => (
              <td key={day.date} className={cx(numClass, i >= 5 && s.weekend)}>
                {durationOrDash(day.total_seconds)}
              </td>
            ))}
            <td className={numClass}>{formatDuration(totals.total_seconds)}</td>
          </tr>
          {hasOver ? (
            <tr>
              <th scope="row" className={s.rowHead}>
                Over limit
              </th>
              {totals.days.map((day, i) => (
                <td key={day.date} className={cx(numClass, i >= 5 && s.weekend)}>
                  {day.overtime_seconds > 0 ? <span className={s.over}>{overtimeText(day.overtime_seconds)}</span> : '—'}
                </td>
              ))}
              <td className={numClass}>
                <span className={s.over} title={totals.weekly_overtime_seconds > 0 ? `Includes ${formatDuration(totals.weekly_overtime_seconds)} over the weekly limit` : undefined}>
                  {overtimeText(totals.overtime_seconds)}
                </span>
              </td>
            </tr>
          ) : null}
        </tfoot>
      </table>
    </TableBox>
  );
}

const EVENT_TEXT: Record<TimesheetEventDTO['action'], string> = {
  submit: 'Submitted',
  approve: 'Approved',
  reject: 'Sent back',
  reopen: 'Reopened',
};

function History({ events, tz }: { events: TimesheetEventDTO[]; tz: string }) {
  if (events.length === 0) return null;
  return (
    <Card title="History" subtitle="Every submission and decision is kept">
      <ul className={s.history}>
        {events.map((e) => (
          <li key={e.id}>
            <span className={s.when}>{formatDateTime(e.created_at, tz)}</span>
            <span>
              <strong>{EVENT_TEXT[e.action]}</strong> by {e.actor_name ?? 'a former member'}
            </span>
            {e.note ? <span className="secondary">“{e.note}”</span> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Status line for a week, written for the employee or for a reviewer. */
function StatusBanner({ sheet, tz, self }: { sheet: TimesheetDTO; tz: string; self: boolean }) {
  const reviewer = sheet.reviewer_name ?? 'a reviewer';
  switch (sheet.status) {
    case 'submitted':
      return (
        <Banner tag="NOTE" title={`Submitted ${formatDateTime(sheet.submitted_at, tz)}`}>
          {self ? 'Waiting for your manager. ' : ''}
          {sheet.changed_since_submit
            ? 'The records changed after submission (for example, a correction was approved). The figures below are current; the submitted totals are kept.'
            : 'The figures match what was submitted.'}
        </Banner>
      );
    case 'approved':
      return (
        <Banner tone="ink" title={`Approved by ${reviewer} · ${formatDateTime(sheet.reviewed_at, tz)}`}>
          This week is locked: corrections and manual time for it need the timesheet reopened first.
          {sheet.note ? ` “${sheet.note}”` : ''}
        </Banner>
      );
    case 'rejected':
      return (
        <Banner tag="SENT BACK" title={`Sent back by ${reviewer}`}>
          “{sheet.note}” {self ? 'Propose any corrections, then submit again.' : ''}
        </Banner>
      );
    case 'reopened':
      return (
        <Banner tag="REOPENED" title={`Reopened by ${reviewer}`}>
          “{sheet.note}” {self ? 'Corrections for this week are open again. Submit when it is right.' : ''}
        </Banner>
      );
    default:
      return null;
  }
}

/** The whole week: status, tiles, grid and history. */
export function TimesheetView({ sheet, tz, self }: { sheet: TimesheetDTO; tz: string; self: boolean }) {
  const totals = countedTotals(sheet);
  return (
    <>
      <StatusBanner sheet={sheet} tz={tz} self={self} />
      <TimesheetTiles totals={totals} limitsText={limitsSummary(sheet.limits)} />
      <Card
        title={sheet.status === 'approved' ? 'Approved hours' : 'Hours by project and day'}
        subtitle={`Week of ${formatDayMonth(sheet.period_start)} · ${sheet.timezone}`}
      >
        <TimesheetGrid totals={totals} label={`Timesheet for the week of ${formatDayMonth(sheet.period_start)}`} />
        <p className="small secondary">
          Sessions count on the day they start, in {sheet.timezone}. Tracked time is what the agent measured; manual and
          corrected time counts once approved. Time over a limit is shown for planning and pay — it says nothing about how
          well someone works.
        </p>
      </Card>
      <History events={sheet.events} tz={tz} />
    </>
  );
}

/** Approve / send back / reopen with a note. Sending back and reopening need a reason. */
export function ReviewPanel({ sheet, onDone }: { sheet: TimesheetDTO; onDone: (t: TimesheetDTO) => void }) {
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const action = useAction();
  const actions = reviewActions(sheet);
  if (actions.length === 0) return null;
  const decide = async (verb: 'approve' | 'reject' | 'reopen') => {
    const text = note.trim();
    if (verb !== 'approve' && text.length < 3) {
      setNoteError(verb === 'reject' ? 'Tell them what to fix.' : 'Say why the week is being reopened.');
      return;
    }
    setNoteError(null);
    const r = await action.run(() => timesheetsApi.review(sheet.id!, verb, text || undefined));
    if (r) {
      setNote('');
      onDone(r);
    }
  };
  return (
    <>
      <TextArea
        label={actions.includes('reopen') ? 'Reason for reopening (shown to the employee)' : 'Note to the employee'}
        hint={actions.includes('approve') ? 'Optional when approving; required when sending back.' : undefined}
        rows={2}
        maxLength={1000}
        value={note}
        error={noteError}
        onChange={(e) => setNote(e.target.value)}
      />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        {actions.includes('reopen') ? (
          <Button onClick={() => decide('reopen')} disabled={action.busy}>
            Reopen week
          </Button>
        ) : null}
        {actions.includes('reject') ? (
          <Button onClick={() => decide('reject')} disabled={action.busy}>
            Send back
          </Button>
        ) : null}
        {actions.includes('approve') ? (
          <Button variant="primary" onClick={() => decide('approve')} disabled={action.busy}>
            Approve and lock
          </Button>
        ) : null}
      </div>
    </>
  );
}

/** Link to a member's week view. */
export function memberTimesheetHref(userId: string, periodStart: string, extra: { team?: string; name?: string } = {}): string {
  const q = new URLSearchParams({ week: periodStart });
  if (extra.team) q.set('team', extra.team);
  if (extra.name) q.set('name', extra.name);
  return `/team/${encodeURIComponent(userId)}/timesheet?${q.toString()}`;
}

export function MemberTimesheetLink({ userId, periodStart, team, name, children }: { userId: string; periodStart: string; team?: string; name?: string; children: ReactNode }) {
  return <Link href={memberTimesheetHref(userId, periodStart, { team, name })}>{children}</Link>;
}
