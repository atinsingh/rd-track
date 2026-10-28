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
  LEDGER_KIND_LABEL,
  REQUEST_STATUS_LABEL,
  accrualLabel,
  attendanceDetail,
  dateSpanLabel,
  formatHours,
  sched,
  shiftTimesLabel,
  signedHours,
  weekLabel,
  weekdaysLabel,
} from '@/lib/scheduling';
import { addDays, formatDateTime, formatShortDay, startOfWeek, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

function WeekAttendance({ data, tz }: { data: AttendanceResponse; tz: string }) {
  const sum = data.summary;
  return (
    <>
      <p className="secondary small">
        {sum.scheduled_days === 0
          ? 'No shifts this week.'
          : `${sum.scheduled_days} scheduled ${sum.scheduled_days === 1 ? 'day' : 'days'} · ${sum.on_time} on schedule · ${sum.late} started late · ${sum.left_early} left early · ${sum.absent} with nothing recorded · ${sum.on_leave} on leave · ${sum.holiday} holiday`}
        . Late means the first recorded time began more than {data.late_grace_minutes} min after the shift start.
      </p>
      <TableBox label="Attendance this week">
        <table className={tableClass} style={{ minWidth: 620 }}>
          <caption className="visually-hidden">Your shifts and recorded time, day by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Shift</th>
              <th scope="col">Status</th>
              <th scope="col">Details</th>
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
  if (balances.length === 0) return <Empty title="No time-off policy yet">An org admin assigns time-off policies.</Empty>;
  return (
    <div className={s.balances}>
      {balances.map((b) => (
        <div key={b.policy_id} className={s.balance}>
          <span className="label-mono">
            {b.policy_name} · {b.kind}
          </span>
          {b.kind === 'paid' ? <span className={s.balanceValue}>{formatHours(b.balance_hours)}</span> : <span className={s.balanceValue}>Unpaid</span>}
          <span className="small secondary">
            {accrualLabel(b)}
            {b.pending_hours > 0 ? ` · ${formatHours(b.pending_hours)} waiting for approval` : ''}
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
        <SelectField label="Policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
          {balances.map((b) => (
            <option key={b.policy_id} value={b.policy_id}>
              {b.policy_name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="First day"
          type="date"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            if (e.target.value > end) setEnd(e.target.value);
          }}
          required
        />
        {partial ? (
          <TextField label="Hours" type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} required />
        ) : (
          <TextField label="Last day" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} required />
        )}
      </div>
      <Checkbox label="Part of a day" hint="For a few hours on one day." checked={partial} onChange={(e) => setPartial(e.target.checked)} />
      <TextArea label="Note for your manager (optional)" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="small secondary" aria-live="polite">
        {!valid
          ? 'Choose the dates.'
          : estimate.data
            ? `This request is ${formatHours(estimate.data.hours)}. Full days count your shift hours on scheduled days; weekends, days off and holidays cost nothing.`
            : estimate.error
              ? 'Couldn’t work out the hours yet.'
              : 'Working out the hours…'}
      </p>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button type="submit" variant="primary" disabled={!valid || action.busy}>
          {action.busy ? 'Sending…' : 'Request time off'}
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
  if (data.requests.length === 0) return <Empty title="No requests yet" />;
  return (
    <>
      <ActionError error={action.error} />
      <TableBox label="Your time-off requests">
        <table className={tableClass} style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th scope="col">Dates</th>
              <th scope="col">Policy</th>
              <th scope="col" className={numClass}>
                Hours
              </th>
              <th scope="col">Status</th>
              <th scope="col">Reviewer note</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
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
                  <Badge tone={r.status === 'approved' ? 'solid' : 'outline'}>{REQUEST_STATUS_LABEL[r.status]}</Badge>
                  {r.reviewer_name ? <span className="small muted"> · {r.reviewer_name}</span> : null}
                </td>
                <td className="small secondary">{r.review_note ? `“${r.review_note}”` : '—'}</td>
                <td>
                  {r.status === 'pending' || (r.status === 'approved' && r.start_date > today) ? (
                    <Button size="sm" variant="quiet" disabled={action.busy} onClick={() => cancel(r.id)} aria-label={`Cancel time off ${dateSpanLabel(r.start_date, r.end_date)}`}>
                      Cancel
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
          <summary className="small">Balance history</summary>
          <TableBox label="Balance history">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Policy</th>
                  <th scope="col">Entry</th>
                  <th scope="col" className={numClass}>
                    Hours
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((e) => (
                  <tr key={e.id}>
                    <td>{formatShortDay(e.effective_date)}</td>
                    <td>{data.balances.find((b) => b.policy_id === e.policy_id)?.policy_name ?? '—'}</td>
                    <td>
                      {LEDGER_KIND_LABEL[e.kind]}
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

  if (!schedules && !timeOff) return <NoAccess what="Your organization's plan doesn't include schedules or time off." />;

  return (
    <>
      <PageHeader
        eyebrow="Employee · Schedule and time off"
        title="My schedule"
        description="Your shifts, how your recorded time lines up with them, and your time off. Your manager sees the same attendance for you — it's about the schedule, not your performance."
        actions={
          schedules ? (
            <DateSwitcher date={day} onDate={setDay} tz={tz} step={7} unit="week" label={`${week === startOfWeek(todayInTz(tz)) ? 'This week · ' : ''}${weekLabel(range.from, range.to)}`} />
          ) : undefined
        }
      />
      {notice ? (
        <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>Dismiss</Button>}>
          Your manager has been notified. You&apos;ll get a notification when it&apos;s reviewed.
        </Banner>
      ) : null}

      {schedules ? (
        <>
          <Card title="Attendance" subtitle={weekLabel(range.from, range.to)}>
            <Resource {...attendance} label="Loading attendance">
              {(data) => <WeekAttendance data={data} tz={tz} />}
            </Resource>
          </Card>
          <Card title="Your shifts">
            <Resource {...schedule} label="Loading your schedule">
              {(data) =>
                data.shifts.length === 0 ? (
                  <Empty title="No recurring shifts">If your organization uses schedules, an org admin assigns them.</Empty>
                ) : (
                  <ul className="stack" style={{ gap: 8, margin: 0, paddingLeft: 18 }}>
                    {data.shifts.map((x) => (
                      <li key={x.id}>
                        <strong>{weekdaysLabel(x.weekdays)}</strong> <span className="mono">{shiftTimesLabel(x)}</span>{' '}
                        <span className="small muted">
                          {x.timezone} · from {formatShortDay(x.effective_from)}
                          {x.effective_to ? ` to ${formatShortDay(x.effective_to)}` : ''}
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
        <Resource {...mine} label="Loading time off">
          {(data) => (
            <>
              <Card title="Time-off balances">
                <Balances balances={data.balances} />
              </Card>
              {data.balances.length > 0 ? (
                <Card title="Request time off">
                  <RequestForm
                    balances={data.balances}
                    onDone={(r) => {
                      setNotice(`Time off requested: ${dateSpanLabel(r.start_date, r.end_date)} · ${formatHours(r.hours)}`);
                      mine.reload();
                    }}
                  />
                </Card>
              ) : null}
              <Card title="Your requests" subtitle={data.requests[0] ? `Latest ${formatDateTime(data.requests[0].created_at, tz)}` : undefined}>
                <Requests data={data} onChanged={mine.reload} />
              </Card>
            </>
          )}
        </Resource>
      ) : null}
    </>
  );
}
