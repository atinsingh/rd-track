'use client';

import { useState, type FormEvent } from 'react';
import type { AttendanceResponse, MyTimeOffResponse, TimeOffBalanceDTO, TimeOffRequestDTO } from '@rd/contracts';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { AttendanceBadge, AttendanceLegend } from '@/components/scheduling/Attendance';
import s from '@/components/scheduling/scheduling.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { useMe } from '@/lib/me';
import {
  accrualLabel,
  attendanceDetail,
  dateSpanLabel,
  formatHours,
  ledgerKindLabel,
  requestStatusLabel,
  sched,
  shiftTimesLabel,
  signedHours,
  weekLabel,
  weekdaysLabel,
} from '@/lib/scheduling';
import { addDays, formatDateTime, formatShortDay, startOfWeek, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import { NoAccess } from '../../NoAccess';

function WeekAttendance({ data, tz }: { data: AttendanceResponse; tz: string }) {
  const sum = data.summary;
  return (
    <>
      <p className="secondary small">
        {sum.scheduled_days === 0
          ? t('sched.noShifts')
          : tPlural(sum.scheduled_days, 'sched.summary.one', 'sched.summary.other', { on_time: sum.on_time,
              late: sum.late,
              left_early: sum.left_early,
              absent: sum.absent,
              on_leave: sum.on_leave,
              holiday: sum.holiday, })}
        {t('sched.lateMeans', { n: data.late_grace_minutes })}
      </p>
      <TableBox label={t('sched.attWeek')}>
        <table className={tableClass} style={{ minWidth: 620 }}>
          <caption className="visually-hidden">{t('sched.attCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('sched.col.day')}</th>
              <th scope="col">{t('sched.col.shift')}</th>
              <th scope="col">{t('sched.col.status')}</th>
              <th scope="col">{t('sched.col.details')}</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.date}>
                <td>{formatShortDay(d.date)}</td>
                <td className="mono">
                  {d.shift ? shiftTimesLabel(d.shift) : '—'}
                  {d.shift && d.shift.timezone !== tz ? <span className="small muted"> {d.shift.timezone}</span> : null}
                </td>
                <td>
                  <AttendanceBadge day={d} />
                </td>
                <td className="small secondary">{attendanceDetail(d, tz) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      <AttendanceLegend />
    </>
  );
}

function Balances({ balances }: { balances: TimeOffBalanceDTO[] }) {
  if (balances.length === 0) return <Empty title={t('sched.noPolicy')}>{t('sched.noPolicyBody')}</Empty>;
  return (
    <div className={s.balances}>
      {balances.map((b) => (
        <div key={b.policy_id} className={s.balance}>
          <span className="label-mono">
            {b.policy_name} · {t(`sched.kind.${b.kind}`)}
          </span>
          {b.kind === 'paid' ? <span className={s.balanceValue}>{formatHours(b.balance_hours)}</span> : <span className={s.balanceValue}>{t('sched.unpaid')}</span>}
          <span className="small secondary">
            {accrualLabel(b)}
            {b.pending_hours > 0 ? t('sched.pendingHours', { hours: formatHours(b.pending_hours) }) : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function RequestForm({ balances, onDone }: { balances: TimeOffBalanceDTO[]; onDone: (r: TimeOffRequestDTO) => void }) {
  const { timezone: tz } = useMe();
  const today = todayInTz(tz);
  const [policyId, setPolicyId] = useState(balances[0]?.policy_id ?? '');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [partial, setPartial] = useState(false);
  const [hours, setHours] = useState('4');
  const [reason, setReason] = useState('');
  const action = useAction();
  const partialHours = partial ? Number(hours) : undefined;
  const valid = !!policyId && !!start && !!end && end >= start && (!partial || (partialHours! > 0 && partialHours! <= 24));
  const effectiveEnd = partial ? start : end;
  const estimate = useApi(valid ? `timeoff:estimate|${start}|${effectiveEnd}|${partialHours ?? ''}` : null, (signal) =>
    sched.my.estimate({ start_date: start, end_date: effectiveEnd, partial_hours: partialHours }, signal),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() =>
      sched.my.request({ policy_id: policyId, start_date: start, end_date: effectiveEnd, partial_hours: partialHours, reason: reason.trim() || undefined }),
    );
    if (r) {
      setReason('');
      onDone(r);
    }
  };
  if (balances.length === 0) return null;
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
      <div className={formGridClass}>
        <SelectField label={t('sched.policy')} value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
          {balances.map((b) => (
            <option key={b.policy_id} value={b.policy_id}>
              {b.policy_name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('sched.firstDay')}
          type="date"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            if (e.target.value > end) setEnd(e.target.value);
          }}
          required
        />
        {partial ? (
          <TextField label={t('sched.hours')} type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} required />
        ) : (
          <TextField label={t('sched.lastDay')} type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} required />
        )}
      </div>
      <Checkbox label={t('sched.partial')} hint={t('sched.partialHint')} checked={partial} onChange={(e) => setPartial(e.target.checked)} />
      <TextArea label={t('sched.noteManager')} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="small secondary" aria-live="polite">
        {!valid
          ? t('sched.chooseDates')
          : estimate.data
            ? t('sched.estimate', { hours: formatHours(estimate.data.hours) })
            : estimate.error
              ? t('sched.estimateFailed')
              : t('sched.estimating')}
      </p>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button type="submit" variant="primary" disabled={!valid || action.busy}>
          {action.busy ? t('sched.sending') : t('sched.requestTimeOff')}
        </Button>
      </div>
    </form>
  );
}

function Requests({ data, onChanged }: { data: MyTimeOffResponse; onChanged: () => void }) {
  const { timezone: tz } = useMe();
  const today = todayInTz(tz);
  const action = useAction();
  const cancel = async (id: string) => {
    if (await action.run(() => sched.my.cancel(id))) onChanged();
  };
  if (data.requests.length === 0) return <Empty title={t('sched.noRequests')} />;
  return (
    <>
      <ActionError error={action.error} />
      <TableBox label={t('sched.yourRequests')}>
        <table className={tableClass} style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th scope="col">{t('sched.col.dates')}</th>
              <th scope="col">{t('sched.col.policy')}</th>
              <th scope="col" className={numClass}>
                {t('sched.col.hours')}
              </th>
              <th scope="col">{t('sched.col.status')}</th>
              <th scope="col">{t('sched.col.reviewerNote')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('sched.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.requests.map((r) => (
              <tr key={r.id}>
                <td>{dateSpanLabel(r.start_date, r.end_date)}</td>
                <td>{r.policy_name}</td>
                <td className={numClass}>{formatHours(r.hours)}</td>
                <td>
                  <Badge tone={r.status === 'approved' ? 'solid' : 'outline'}>{requestStatusLabel(r.status)}</Badge>
                  {r.reviewer_name ? <span className="small muted"> · {r.reviewer_name}</span> : null}
                </td>
                <td className="small secondary">{r.review_note ? `“${r.review_note}”` : '—'}</td>
                <td>
                  {r.status === 'pending' || (r.status === 'approved' && r.start_date > today) ? (
                    <Button size="sm" variant="quiet" disabled={action.busy} onClick={() => cancel(r.id)} aria-label={t('sched.cancelLabel', { dates: dateSpanLabel(r.start_date, r.end_date) })}>
                      {t('common.cancel')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      {data.ledger.length > 0 ? (
        <details>
          <summary className="small">{t('sched.history')}</summary>
          <TableBox label={t('sched.history')}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">{t('sched.col.date')}</th>
                  <th scope="col">{t('sched.col.policy')}</th>
                  <th scope="col">{t('sched.col.entry')}</th>
                  <th scope="col" className={numClass}>
                    {t('sched.col.hours')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((e) => (
                  <tr key={e.id}>
                    <td>{formatShortDay(e.effective_date)}</td>
                    <td>{data.balances.find((b) => b.policy_id === e.policy_id)?.policy_name ?? '—'}</td>
                    <td>
                      {ledgerKindLabel(e.kind)}
                      {e.note ? <span className="small muted"> · {e.note}</span> : null}
                    </td>
                    <td className={numClass}>{signedHours(e.hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        </details>
      ) : null}
    </>
  );
}

export default function MySchedulePage() {
  const { me, timezone: tz } = useMe();
  const schedules = me.entitlements.includes('schedules');
  const timeOff = me.entitlements.includes('time_off');
  const [day, setDay] = useState(() => todayInTz(tz));
  const [notice, setNotice] = useState<string | null>(null);
  const week = startOfWeek(day);
  const range = { from: week, to: addDays(week, 6) };
  const attendance = useApi(schedules ? `me:attendance|${range.from}` : null, (signal) => sched.my.attendance(range, signal));
  const schedule = useApi(schedules ? `me:schedule|${range.from}` : null, (signal) => sched.my.schedule(range, signal));
  const mine = useApi(timeOff ? 'me:time-off' : null, (signal) => sched.my.timeOff(signal));

  if (!schedules && !timeOff) return <NoAccess what={t('sched.noAccess')} />;

  return (
    <>
      <PageHeader
        eyebrow={t('sched.eyebrow')}
        title={t('sched.title')}
        description={t('sched.description')}
        actions={
          schedules ? (
            <DateSwitcher date={day} onDate={setDay} tz={tz} step={7} unit="week" label={`${week === startOfWeek(todayInTz(tz)) ? t('ts.thisWeekPrefix') : ''}${weekLabel(range.from, range.to)}`} />
          ) : undefined
        }
      />
      {notice ? (
        <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>{t('common.dismiss')}</Button>}>
          {t('sched.notified')}
        </Banner>
      ) : null}

      {schedules ? (
        <>
          <Card title={t('sched.attendance')} subtitle={weekLabel(range.from, range.to)}>
            <Resource {...attendance} label={t('sched.loadingAttendance')}>
              {(data) => <WeekAttendance data={data} tz={tz} />}
            </Resource>
          </Card>
          <Card title={t('sched.yourShifts')}>
            <Resource {...schedule} label={t('sched.loadingSchedule')}>
              {(data) =>
                data.shifts.length === 0 ? (
                  <Empty title={t('sched.noRecurring')}>{t('sched.noRecurringBody')}</Empty>
                ) : (
                  <ul className="stack" style={{ gap: 8, margin: 0, paddingLeft: 18 }}>
                    {data.shifts.map((x) => (
                      <li key={x.id}>
                        <strong>{weekdaysLabel(x.weekdays)}</strong> <span className="mono">{shiftTimesLabel(x)}</span>{' '}
                        <span className="small muted">
                          {x.timezone}
                          {t('sched.from', { date: formatShortDay(x.effective_from) })}
                          {x.effective_to ? t('sched.to', { date: formatShortDay(x.effective_to) }) : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Resource>
          </Card>
        </>
      ) : null}

      {timeOff ? (
        <Resource {...mine} label={t('sched.loadingTimeOff')}>
          {(data) => (
            <>
              <Card title={t('sched.balances')}>
                <Balances balances={data.balances} />
              </Card>
              {data.balances.length > 0 ? (
                <Card title={t('sched.requestTimeOff')}>
                  <RequestForm
                    balances={data.balances}
                    onDone={(r) => {
                      setNotice(t('sched.requested', { dates: dateSpanLabel(r.start_date, r.end_date), hours: formatHours(r.hours) }));
                      mine.reload();
                    }}
                  />
                </Card>
              ) : null}
              <Card title={t('sched.requestsTitle')} subtitle={data.requests[0] ? t('sched.latest', { when: formatDateTime(data.requests[0].created_at, tz) }) : undefined}>
                <Requests data={data} onChanged={mine.reload} />
              </Card>
            </>
          )}
        </Resource>
      ) : null}
    </>
  );
}
