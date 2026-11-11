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
import { countedTotals, limitsSummary, overtimeText, reviewActions, statusLabel, statusTone, timesheetGrid, timesheetsApi } from '@/lib/timesheets';
import { useAction } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import s from './timesheet.module.css';

export function StatusBadge({ status }: { status: TimesheetDTO['status'] }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

/** Tracked / manual / corrected / over-limit tiles for a week. */
export function TimesheetTiles({ totals, limitsText }: { totals: TimesheetTotals; limitsText: string }) {
  return (
    <section aria-label={t('ts.weekSummary')} className={d.tiles}>
      <div className={d.tile}>
        <span className={d.tileLabel}>{t('ts.tile.total')}</span>
        <span className={d.tileValue}>{formatDuration(totals.total_seconds)}</span>
        <span className={d.tileSub}>{t('ts.tile.totalSub')}</span>
      </div>
      <div className={d.tile}>
        <span className={d.tileLabel}>{t('ts.tile.tracked')}</span>
        <span className={d.tileValue}>{formatDuration(totals.tracked_seconds)}</span>
        <span className={d.tileSub}>{t('ts.tile.trackedSub')}</span>
      </div>
      <div className={d.tile}>
        <span className={d.tileLabel}>{t('ts.tile.manual')}</span>
        <span className={d.tileValue}>{formatDuration(totals.manual_seconds + totals.corrected_seconds)}</span>
        <span className={d.tileSub}>
          {t('ts.tile.manualSub', { manual: durationOrDash(totals.manual_seconds), corrected: durationOrDash(totals.corrected_seconds) })}
        </span>
      </div>
      <div className={d.tile}>
        <span className={d.tileLabel}>{t('ts.tile.over')}</span>
        <span className={d.tileValue}>{totals.overtime_seconds > 0 ? formatDuration(totals.overtime_seconds) : '—'}</span>
        <span className={d.tileSub}>{limitsText}</span>
      </div>
    </section>
  );
}

/** Project × day grid with daily totals and time over the daily limit. */
export function TimesheetGrid({ totals, label }: { totals: TimesheetTotals; label: string }) {
  const rows = timesheetGrid(totals);
  if (rows.length === 0) return <Empty title={t('ts.gridEmpty')}>{t('ts.gridEmptyBody')}</Empty>;
  const hasOver = totals.days.some((x) => x.overtime_seconds > 0) || totals.weekly_overtime_seconds > 0;
  return (
    <TableBox label={label}>
      <table className={cx(tableClass, s.grid)} style={{ minWidth: 820 }}>
        <caption className="visually-hidden">{t('ts.gridCaption', { label })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ts.col.project')}</th>
            {totals.days.map((day, i) => (
              <th key={day.date} scope="col" className={cx(numClass, i >= 5 && s.weekend)}>
                {weekdayShort(i + 1)} {formatDayMonth(day.date)}
              </th>
            ))}
            <th scope="col" className={numClass}>
              {t('ts.col.total')}
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
              {t('ts.dayTotal')}
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
                {t('ts.col.over')}
              </th>
              {totals.days.map((day, i) => (
                <td key={day.date} className={cx(numClass, i >= 5 && s.weekend)}>
                  {day.overtime_seconds > 0 ? <span className={s.over}>{overtimeText(day.overtime_seconds)}</span> : '—'}
                </td>
              ))}
              <td className={numClass}>
                <span className={s.over} title={totals.weekly_overtime_seconds > 0 ? t('ts.includesWeekly', { over: formatDuration(totals.weekly_overtime_seconds) }) : undefined}>
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

const eventText = (a: TimesheetEventDTO['action']): string => t(`ts.event.${a}`);

function History({ events, tz }: { events: TimesheetEventDTO[]; tz: string }) {
  if (events.length === 0) return null;
  return (
    <Card title={t('ts.history')} subtitle={t('ts.historySub')}>
      <ul className={s.history}>
        {events.map((e) => (
          <li key={e.id}>
            <span className={s.when}>{formatDateTime(e.created_at, tz)}</span>
            <span>
              <strong>{eventText(e.action)}</strong>
              {t('ts.by', { name: e.actor_name ?? t('ts.formerMember') })}
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
  const reviewer = sheet.reviewer_name ?? t('ts.aReviewer');
  switch (sheet.status) {
    case 'submitted':
      return (
        <Banner tag="NOTE" title={t('ts.submittedAt', { when: formatDateTime(sheet.submitted_at, tz) })}>
          {self ? t('ts.waitingManager') : ''}
          {sheet.changed_since_submit ? t('ts.changed') : t('ts.matches')}
        </Banner>
      );
    case 'approved':
      return (
        <Banner tone="ink" title={t('ts.approvedBy', { name: reviewer, when: formatDateTime(sheet.reviewed_at, tz) })}>
          {t('ts.locked')}
          {sheet.note ? ` “${sheet.note}”` : ''}
        </Banner>
      );
    case 'rejected':
      return (
        <Banner tag={t('ts.sentBackTag')} title={t('ts.sentBackBy', { name: reviewer })}>
          “{sheet.note}” {self ? t('ts.sentBackSelf') : ''}
        </Banner>
      );
    case 'reopened':
      return (
        <Banner tag={t('ts.reopenedTag')} title={t('ts.reopenedBy', { name: reviewer })}>
          “{sheet.note}” {self ? t('ts.reopenedSelf') : ''}
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
        title={sheet.status === 'approved' ? t('ts.approvedHours') : t('ts.hoursByProject')}
        subtitle={t('ts.weekOf', { date: formatDayMonth(sheet.period_start), tz: sheet.timezone })}
      >
        <TimesheetGrid totals={totals} label={t('ts.gridLabel', { date: formatDayMonth(sheet.period_start) })} />
        <p className="small secondary">{t('ts.explain', { tz: sheet.timezone })}</p>
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
      setNoteError(verb === 'reject' ? t('ts.tellFix') : t('ts.sayWhy'));
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
        label={actions.includes('reopen') ? t('ts.reasonReopen') : t('ts.noteEmployee')}
        hint={actions.includes('approve') ? t('ts.noteHint') : undefined}
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
            {t('ts.reopen')}
          </Button>
        ) : null}
        {actions.includes('reject') ? (
          <Button onClick={() => decide('reject')} disabled={action.busy}>
            {t('ts.sendBack')}
          </Button>
        ) : null}
        {actions.includes('approve') ? (
          <Button variant="primary" onClick={() => decide('approve')} disabled={action.busy}>
            {t('ts.approve')}
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
