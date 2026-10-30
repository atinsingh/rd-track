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
import { t } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { sched, shiftTimesLabel, weekdaysLabel } from '@/lib/scheduling';
import { addDays, formatShortDay, timeZoneOptions, todayInTz, weekdaysShort } from '@/lib/time';
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
        <TextField label={t('adm.sch.lateAfter')} hint={t('adm.sch.lateHint')} type="number" min={0} max={240} value={late} onChange={(e) => setLate(e.target.value)} required />
        <TextField label={t('adm.sch.earlyBefore')} hint={t('adm.sch.earlyHint')} type="number" min={0} max={240} value={early} onChange={(e) => setEarly(e.target.value)} required />
        <TextField label={t('adm.sch.defaultDay')} hint={t('adm.sch.defaultDayHint')} type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} required />
      </div>
      <ActionError error={action.error} />
      {saved ? (
        <p role="status" className="small">
          {t('adm.sch.savedNote')}
        </p>
      ) : null}
      <div className={formActionsClass}>
        <Button type="submit" disabled={action.busy}>
          {t('adm.sch.saveSettings')}
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
        <SelectField label={t('adm.common.person')} value={userId} onChange={(e) => setUserId(e.target.value)} required>
          <option value="">{t('adm.common.choosePerson')}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </SelectField>
        <TextField label={t('adm.common.starts')} type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        <TextField label={t('adm.common.ends')} type="time" value={end} onChange={(e) => setEnd(e.target.value)} hint={end <= start ? t('adm.sch.overnight') : undefined} required />
        <SelectField label={t('date.timeZone')} value={tz} onChange={(e) => setTz(e.target.value)}>
          <option value="">{person ? t('adm.sch.personTzOf', { tz: person.timezone }) : t('adm.sch.personTz')}</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </SelectField>
        <TextField label={t('adm.common.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        <TextField label={t('adm.common.untilOptional')} type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <fieldset className={s.weekdayPicks}>
        <legend>{t('adm.common.days')}</legend>
        {weekdaysShort().map((label, i) => (
          <label key={label}>
            <input type="checkbox" checked={days.includes(i + 1)} onChange={() => toggle(i + 1)} />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="small muted">{t('adm.sch.notifyNote')}</p>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button type="submit" variant="primary" disabled={!userId || days.length === 0 || start === end || action.busy}>
          {t('adm.sch.assign')}
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
      <SelectField label={t('adm.common.person')} value={userId} onChange={(e) => setUserId(e.target.value)} required>
        <option value="">{t('adm.common.choosePerson')}</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name}
          </option>
        ))}
      </SelectField>
      <TextField label={t('adm.common.day')} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <SelectField label={t('adm.sch.change')} value={kind} onChange={(e) => setKind(e.target.value as 'change' | 'cancel')}>
        <option value="cancel">{t('adm.sch.noShiftThatDay')}</option>
        <option value="change">{t('adm.sch.differentHours')}</option>
      </SelectField>
      {kind === 'change' ? (
        <>
          <TextField label={t('adm.common.starts')} type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          <TextField label={t('adm.common.ends')} type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </>
      ) : null}
      <TextField label={t('adm.common.noteOptional')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" disabled={!userId || action.busy}>
        {t('adm.sch.saveChange')}
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

  if (!access.isAdmin) return <NoAccess what={t('adm.sch.noAccessAdmin')} />;
  if (!enabled) return <NoAccess what={t('adm.sch.noAccessPlan')} />;
  const people = [...(users.data ?? [])].filter((u) => u.status === 'active').sort(byName);

  const removeShift = async (x: ShiftDTO) => {
    setEnded(null);
    const r = await remove.run(() => sched.admin.removeShift(x.id));
    if (r) {
      setEnded(r.ended ? t('adm.sch.endedPast', { name: x.user_name }) : t('adm.sch.removedFuture', { name: x.user_name }));
      shifts.reload();
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('adm.sch.eyebrow')}
        title={t('adm.sch.title')}
        description={t('adm.sch.description')}
      />
      <Card title={t('adm.sch.settings')}>
        <Resource {...settings} label={t('adm.sch.loadingSettings')}>
          {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} onSaved={(x) => settings.mutate(() => x)} />}
        </Resource>
      </Card>
      <Card title={t('adm.sch.assignTitle')}>
        <ShiftForm users={people} onCreated={(x) => shifts.mutate((prev) => [...(prev ?? []), x])} />
      </Card>
      <Card title={t('adm.sch.shifts')}>
        {ended ? <Banner role="status" title={ended} /> : null}
        <ActionError error={remove.error} />
        <Resource {...shifts} label={t('adm.sch.loadingShifts')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('adm.sch.noShifts')} />
            ) : (
              <TableBox label={t('adm.sch.shifts')}>
                <table className={tableClass} style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.common.person')}</th>
                      <th scope="col">{t('adm.common.days')}</th>
                      <th scope="col">{t('adm.common.hours')}</th>
                      <th scope="col">{t('date.timeZone')}</th>
                      <th scope="col">{t('adm.sch.inEffect')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
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
                            {formatShortDay(x.effective_from)} – {x.effective_to ? formatShortDay(x.effective_to) : t('adm.sch.ongoing')}
                          </td>
                          <td>
                            {!x.effective_to || x.effective_to >= today ? (
                              <Button size="sm" variant="danger" disabled={remove.busy} onClick={() => removeShift(x)} aria-label={t('adm.sch.endLabel', { name: x.user_name })}>
                                {x.effective_from >= today ? t('adm.common.remove') : t('adm.sch.end')}
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
      <Card title={t('adm.sch.oneOff')} subtitle={t('adm.sch.oneOffSub')}>
        <OverrideForm users={people} onSaved={overrides.reload} />
        <Resource {...overrides} label={t('adm.sch.loadingChanges')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('adm.sch.noOneOff')} />
            ) : (
              <TableBox label={t('adm.sch.oneOff')}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.common.day')}</th>
                      <th scope="col">{t('adm.common.person')}</th>
                      <th scope="col">{t('adm.sch.change')}</th>
                      <th scope="col">{t('adm.common.note')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((o) => (
                      <tr key={o.id}>
                        <td>{formatShortDay(o.date)}</td>
                        <td>{o.user_name}</td>
                        <td className="mono">{o.kind === 'cancel' ? t('adm.sch.noShift') : shiftTimesLabel({ start_time: o.start_time!, end_time: o.end_time! })}</td>
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
                            {t('adm.common.undo')}
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
