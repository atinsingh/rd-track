'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { SchedulingSettingsDTO, ShiftDTO, UserDTO } from '@rd/contracts';
import s from '@/components/scheduling/scheduling.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, tableClass } from '@/components/ui/Layout';
import { byName } from '@/lib/format';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { sched, shiftTimesLabel, weekdaysLabel } from '@/lib/scheduling';
import { WEEKDAY_SHORT, addDays, formatShortDay, timeZoneOptions, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

function SettingsForm({ settings, onSaved }: { settings: SchedulingSettingsDTO; onSaved: (s: SchedulingSettingsDTO) => void }) {
  const [late, setLate] = useState(String(settings.late_grace_minutes));
  const [early, setEarly] = useState(String(settings.early_leave_grace_minutes));
  const [hours, setHours] = useState(String(settings.default_day_hours));
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const r = await action.run(() =>
      sched.admin.updateSettings({ late_grace_minutes: Number(late), early_leave_grace_minutes: Number(early), default_day_hours: Number(hours) }),
    );
    if (r) {
      setSaved(true);
      onSaved(r);
    }
  };
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
      <div className={formGridClass}>
        <TextField label="Late after (minutes)" hint="Grace after the shift start" type="number" min={0} max={240} value={late} onChange={(e) => setLate(e.target.value)} required />
        <TextField label="Left early before (minutes)" hint="Grace before the shift end" type="number" min={0} max={240} value={early} onChange={(e) => setEarly(e.target.value)} required />
        <TextField label="Default day (hours)" hint="What a full day of leave costs, Mon–Fri, for people without a shift" type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} required />
      </div>
      <ActionError error={action.error} />
      {saved ? (
        <p role="status" className="small">
          Saved. Attendance is worked out when it&apos;s viewed, so past days use the new settings too.
        </p>
      ) : null}
      <div className={formActionsClass}>
        <Button type="submit" disabled={action.busy}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

function ShiftForm({ users, onCreated }: { users: UserDTO[]; onCreated: (s: ShiftDTO) => void }) {
  const { timezone } = useMe();
  const [userId, setUserId] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [from, setFrom] = useState(() => todayInTz(timezone));
  const [to, setTo] = useState('');
  const [tz, setTz] = useState('');
  const action = useAction();
  const person = users.find((u) => u.id === userId);
  const zones = useMemo(() => timeZoneOptions(person?.timezone ?? 'UTC'), [person?.timezone]);
  const toggle = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() =>
      sched.admin.createShift({
        user_id: userId,
        weekdays: days,
        start_time: start,
        end_time: end,
        effective_from: from,
        effective_to: to || null,
        ...(tz ? { timezone: tz } : {}),
      }),
    );
    if (r) onCreated(r);
  };
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
      <div className={formGridClass}>
        <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} required>
          <option value="">Choose a person…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </SelectField>
        <TextField label="Starts" type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        <TextField label="Ends" type="time" value={end} onChange={(e) => setEnd(e.target.value)} hint={end <= start ? 'Ends the next day (overnight)' : undefined} required />
        <SelectField label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)}>
          <option value="">Person&apos;s time zone{person ? ` (${person.timezone})` : ''}</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </SelectField>
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        <TextField label="Until (optional)" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <fieldset className={s.weekdayPicks}>
        <legend>Days</legend>
        {WEEKDAY_SHORT.map((label, i) => (
          <label key={label}>
            <input type="checkbox" checked={days.includes(i + 1)} onChange={() => toggle(i + 1)} />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="small muted">The person is notified when their schedule changes. An overnight shift belongs to the day it starts.</p>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button type="submit" variant="primary" disabled={!userId || days.length === 0 || start === end || action.busy}>
          Assign shift
        </Button>
      </div>
    </form>
  );
}

function OverrideForm({ users, onSaved }: { users: UserDTO[]; onSaved: () => void }) {
  const { timezone } = useMe();
  const [userId, setUserId] = useState('');
  const [date, setDate] = useState(() => todayInTz(timezone));
  const [kind, setKind] = useState<'change' | 'cancel'>('cancel');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [note, setNote] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() =>
      sched.admin.setOverride({ user_id: userId, date, kind, ...(kind === 'change' ? { start_time: start, end_time: end } : {}), note: note.trim() || undefined }),
    );
    if (r) {
      setNote('');
      onSaved();
    }
  };
  return (
    <form onSubmit={submit} className={s.inlineForm}>
      <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} required>
        <option value="">Choose a person…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name}
          </option>
        ))}
      </SelectField>
      <TextField label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <SelectField label="Change" value={kind} onChange={(e) => setKind(e.target.value as 'change' | 'cancel')}>
        <option value="cancel">No shift that day</option>
        <option value="change">Different hours</option>
      </SelectField>
      {kind === 'change' ? (
        <>
          <TextField label="Starts" type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          <TextField label="Ends" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </>
      ) : null}
      <TextField label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" disabled={!userId || action.busy}>
        Save change
      </Button>
      <ActionError error={action.error} />
    </form>
  );
}

export default function SchedulesAdminPage() {
  const { access, me, timezone } = useMe();
  const enabled = access.isAdmin && me.entitlements.includes('schedules');
  const today = todayInTz(timezone);
  const settings = useApi(enabled ? 'admin:sched-settings' : null, (signal) => sched.admin.settings(signal));
  const users = useApi(enabled ? 'admin:users' : null, (signal) => rd.admin.users(signal));
  const shifts = useApi(enabled ? 'admin:shifts' : null, (signal) => sched.admin.shifts(signal));
  const overrides = useApi(enabled ? `admin:overrides|${today}` : null, (signal) => sched.admin.overrides({ from: addDays(today, -7), to: addDays(today, 90) }, signal));
  const remove = useAction();
  const [ended, setEnded] = useState<string | null>(null);

  if (!access.isAdmin) return <NoAccess what="Schedules are managed by org admins." />;
  if (!enabled) return <NoAccess what="Schedules and attendance are part of the Pro plan. An org admin can change the plan in Billing." />;
  const people = [...(users.data ?? [])].filter((u) => u.status === 'active').sort(byName);

  const removeShift = async (x: ShiftDTO) => {
    setEnded(null);
    const r = await remove.run(() => sched.admin.removeShift(x.id));
    if (r) {
      setEnded(r.ended ? `${x.user_name}'s shift ends yesterday; past attendance keeps it.` : `${x.user_name}'s future shift was removed.`);
      shifts.reload();
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Admin · Schedules"
        title="Schedules"
        description="Recurring shifts per person, one-off changes and how attendance is worked out. Attendance is about the schedule, never a score."
      />
      <Card title="Attendance settings">
        <Resource {...settings} label="Loading settings">
          {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} onSaved={(x) => settings.mutate(() => x)} />}
        </Resource>
      </Card>
      <Card title="Assign a recurring shift">
        <ShiftForm users={people} onCreated={(x) => shifts.mutate((prev) => [...(prev ?? []), x])} />
      </Card>
      <Card title="Shifts">
        {ended ? <Banner role="status" title={ended} /> : null}
        <ActionError error={remove.error} />
        <Resource {...shifts} label="Loading shifts">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No shifts yet" />
            ) : (
              <TableBox label="Shifts">
                <table className={tableClass} style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Days</th>
                      <th scope="col">Hours</th>
                      <th scope="col">Time zone</th>
                      <th scope="col">In effect</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list]
                      .sort((a, b) => a.user_name.localeCompare(b.user_name) || a.effective_from.localeCompare(b.effective_from))
                      .map((x) => (
                        <tr key={x.id}>
                          <td>{x.user_name}</td>
                          <td>{weekdaysLabel(x.weekdays)}</td>
                          <td className="mono">{shiftTimesLabel(x)}</td>
                          <td className="small">{x.timezone}</td>
                          <td className="small">
                            {formatShortDay(x.effective_from)} – {x.effective_to ? formatShortDay(x.effective_to) : 'ongoing'}
                          </td>
                          <td>
                            {!x.effective_to || x.effective_to >= today ? (
                              <Button size="sm" variant="danger" disabled={remove.busy} onClick={() => removeShift(x)} aria-label={`End ${x.user_name}'s shift`}>
                                {x.effective_from >= today ? 'Remove' : 'End'}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>
      <Card title="One-off changes" subtitle="Last week and the next 90 days">
        <OverrideForm users={people} onSaved={overrides.reload} />
        <Resource {...overrides} label="Loading changes">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No one-off changes" />
            ) : (
              <TableBox label="One-off changes">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Person</th>
                      <th scope="col">Change</th>
                      <th scope="col">Note</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((o) => (
                      <tr key={o.id}>
                        <td>{formatShortDay(o.date)}</td>
                        <td>{o.user_name}</td>
                        <td className="mono">{o.kind === 'cancel' ? 'No shift' : shiftTimesLabel({ start_time: o.start_time!, end_time: o.end_time! })}</td>
                        <td className="small secondary">{o.note ?? '—'}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="quiet"
                            disabled={remove.busy}
                            onClick={async () => {
                              if (await remove.run(() => sched.admin.removeOverride(o.id))) overrides.reload();
                            }}
                          >
                            Undo
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>
    </>
  );
}
