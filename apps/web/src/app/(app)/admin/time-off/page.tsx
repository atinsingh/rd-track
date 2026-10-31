'use client';

import { useState, type FormEvent } from 'react';
import { TIME_OFF_ACCRUAL_DAYS, type TimeOffAccrual, type TimeOffAccrualDay, type TimeOffAssignmentDTO, type TimeOffPolicyDTO, type UserDTO } from '@rd/contracts';
import s from '@/components/scheduling/scheduling.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { accrualDayLabel, accrualLabel, formatHours, sched } from '@/lib/scheduling';
import { formatShortDay, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

const optionalNumber = (v: string): number | null => (v.trim() === '' ? null : Number(v));

function PolicyForm({ onCreated }: { onCreated: (p: TimeOffPolicyDTO) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'paid' | 'unpaid'>('paid');
  const [accrual, setAccrual] = useState<TimeOffAccrual>('per_month');
  const [hours, setHours] = useState('10');
  const [day, setDay] = useState<TimeOffAccrualDay>('first');
  const [max, setMax] = useState('');
  const [carry, setCarry] = useState('');
  const [negative, setNegative] = useState(false);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() =>
      sched.admin.createPolicy({
        name: name.trim(),
        kind,
        accrual,
        accrual_hours: accrual === 'none' ? 0 : Number(hours),
        accrual_day: day,
        max_balance_hours: optionalNumber(max),
        carryover_hours: optionalNumber(carry),
        allow_negative: negative,
      }),
    );
    if (r) {
      setName('');
      onCreated(r);
    }
  };
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
      <div className={formGridClass}>
        <TextField label={t('adm.common.name')} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('adm.to.namePlaceholder')} required />
        <SelectField label={t('adm.to.kind')} value={kind} onChange={(e) => setKind(e.target.value as 'paid' | 'unpaid')}>
          <option value="paid">{t('adm.to.kindPaid')}</option>
          <option value="unpaid">{t('adm.to.kindUnpaid')}</option>
        </SelectField>
        <SelectField label={t('adm.to.accrual')} value={accrual} onChange={(e) => setAccrual(e.target.value as TimeOffAccrual)}>
          <option value="none">{t('adm.to.accrualNone')}</option>
          <option value="per_month">{t('adm.to.everyMonth')}</option>
          <option value="per_year">{t('adm.to.everyYear')}</option>
        </SelectField>
        {accrual !== 'none' ? (
          <>
            <TextField label={t('adm.to.hoursEach')} type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} required />
            <SelectField label={t('adm.to.added')} value={day} onChange={(e) => setDay(e.target.value as TimeOffAccrualDay)} hint={t('adm.to.addedHint')}>
              {TIME_OFF_ACCRUAL_DAYS.map((d) => (
                <option key={d} value={d}>
                  {accrualDayLabel(accrual, d)[0]!.toUpperCase() + accrualDayLabel(accrual, d).slice(1)}
                </option>
              ))}
            </SelectField>
          </>
        ) : null}
        <TextField label={t('adm.to.max')} hint={t('adm.to.maxHint')} type="number" min={0} step={0.5} value={max} onChange={(e) => setMax(e.target.value)} />
        <TextField label={t('adm.to.carry')} hint={t('adm.to.carryHint')} type="number" min={0} step={0.5} value={carry} onChange={(e) => setCarry(e.target.value)} />
      </div>
      <Checkbox label={t('adm.to.negative')} hint={t('adm.to.negativeHint')} checked={negative} onChange={(e) => setNegative(e.target.checked)} />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button type="submit" variant="primary" disabled={!name.trim() || action.busy}>
          {t('adm.to.create')}
        </Button>
      </div>
    </form>
  );
}

function AssignForm({ policies, users, onAssigned }: { policies: TimeOffPolicyDTO[]; users: UserDTO[]; onAssigned: (a: TimeOffAssignmentDTO) => void }) {
  const { timezone } = useMe();
  const [policyId, setPolicyId] = useState('');
  const [userId, setUserId] = useState('');
  const [start, setStart] = useState(() => todayInTz(timezone));
  const [opening, setOpening] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const o = optionalNumber(opening);
    const r = await action.run(() => sched.admin.assign({ policy_id: policyId, user_id: userId, start_date: start, ...(o ? { opening_balance_hours: o } : {}) }));
    if (r) {
      setUserId('');
      setOpening('');
      onAssigned(r);
    }
  };
  return (
    <form onSubmit={submit} className={s.inlineForm}>
      <SelectField label={t('sched.policy')} value={policyId} onChange={(e) => setPolicyId(e.target.value)} required>
        <option value="">{t('adm.to.choosePolicy')}</option>
        {policies.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>
      <SelectField label={t('adm.common.person')} value={userId} onChange={(e) => setUserId(e.target.value)} required>
        <option value="">{t('adm.common.choosePerson')}</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name}
          </option>
        ))}
      </SelectField>
      <TextField label={t('adm.common.from')} type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
      <TextField label={t('adm.to.opening')} type="number" step={0.5} value={opening} onChange={(e) => setOpening(e.target.value)} />
      <Button type="submit" disabled={!policyId || !userId || action.busy}>
        {t('adm.to.assign')}
      </Button>
      <ActionError error={action.error} />
    </form>
  );
}

function AssignmentRow({ a, onChanged }: { a: TimeOffAssignmentDTO; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  const adjust = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => sched.admin.adjust({ policy_id: a.policy_id, user_id: a.user_id, hours: Number(hours), note: note.trim() }))) {
      setOpen(false);
      setHours('');
      setNote('');
      onChanged();
    }
  };
  return (
    <>
      <tr>
        <td>{a.user_name}</td>
        <td>{a.policy_name}</td>
        <td>{formatShortDay(a.start_date)}</td>
        <td className={numClass}>{formatHours(a.balance_hours)}</td>
        <td>
          <span className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="quiet" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {t('adm.to.adjust')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={action.busy}
              aria-label={t('adm.to.removeFrom', { name: a.user_name, policy: a.policy_name })}
              onClick={async () => {
                if (await action.run(() => sched.admin.unassign(a.id))) onChanged();
              }}
            >
              {t('adm.common.remove')}
            </Button>
          </span>
        </td>
      </tr>
      {open || action.error ? (
        <tr>
          <td colSpan={5}>
            {open ? (
              <form onSubmit={adjust} className={s.inlineForm}>
                <TextField label={t('adm.to.hoursSigned')} type="number" step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} required />
                <TextField label={t('adm.to.noteShown')} value={note} minLength={3} maxLength={500} onChange={(e) => setNote(e.target.value)} required />
                <Button type="submit" disabled={!hours || Number(hours) === 0 || note.trim().length < 3 || action.busy}>
                  {t('adm.to.saveAdjustment')}
                </Button>
              </form>
            ) : null}
            <ActionError error={action.error} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function TimeOffPoliciesPage() {
  const { access, me } = useMe();
  const enabled = access.isAdmin && me.entitlements.includes('time_off');
  const policies = useApi(enabled ? 'admin:timeoff-policies' : null, (signal) => sched.admin.policies(signal));
  const assignments = useApi(enabled ? 'admin:timeoff-assignments' : null, (signal) => sched.admin.assignments(signal));
  const users = useApi(enabled ? 'admin:users' : null, (signal) => rd.admin.users(signal));
  const archive = useAction();

  if (!access.isAdmin) return <NoAccess what={t('adm.to.noAccessAdmin')} />;
  if (!enabled) return <NoAccess what={t('adm.to.noAccessPlan')} />;
  const people = [...(users.data ?? [])].filter((u) => u.status === 'active').sort(byName);
  const active = (policies.data ?? []).filter((p) => !p.archived);
  const refresh = () => {
    policies.reload();
    assignments.reload();
  };

  return (
    <>
      <PageHeader
        eyebrow={t('adm.to.eyebrow')}
        title={t('adm.to.title')}
        description={t('adm.to.description')}
      />
      <Card title={t('adm.to.newPolicy')}>
        <PolicyForm onCreated={(p) => policies.mutate((prev) => [...(prev ?? []), p])} />
      </Card>
      <Card title={t('adm.to.policies')}>
        <ActionError error={archive.error} />
        <Resource {...policies} label={t('adm.to.loadingPolicies')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('adm.to.noPolicies')} />
            ) : (
              <TableBox label={t('adm.to.title')}>
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.common.name')}</th>
                      <th scope="col">{t('adm.to.kind')}</th>
                      <th scope="col">{t('adm.to.accrual')}</th>
                      <th scope="col">{t('adm.to.limits')}</th>
                      <th scope="col" className={numClass}>
                        {t('adm.to.people')}
                      </th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.name} {p.archived ? <Badge>{t('adm.to.archived')}</Badge> : null}
                        </td>
                        <td>{p.kind === 'paid' ? t('adm.to.paid') : t('sched.unpaid')}</td>
                        <td>{accrualLabel(p)}</td>
                        <td className="small secondary">
                          {[
                            p.max_balance_hours !== null ? t('adm.to.maxOf', { hours: formatHours(p.max_balance_hours) }) : null,
                            p.carryover_hours !== null ? t('adm.to.carryOf', { hours: formatHours(p.carryover_hours) }) : null,
                            p.allow_negative ? t('adm.to.mayNegative') : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                        <td className={numClass}>{p.assigned_count}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="quiet"
                            disabled={archive.busy}
                            onClick={async () => {
                              if (await archive.run(() => sched.admin.updatePolicy(p.id, { archived: !p.archived }))) refresh();
                            }}
                          >
                            {p.archived ? t('adm.to.restore') : t('adm.to.archive')}
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
      <Card title={t('adm.to.who')}>
        {active.length > 0 ? <AssignForm policies={active} users={people} onAssigned={() => assignments.reload()} /> : null}
        <Resource {...assignments} label={t('adm.to.loadingAssignments')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('adm.to.nobody')} />
            ) : (
              <TableBox label={t('adm.to.assignments')}>
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.common.person')}</th>
                      <th scope="col">{t('sched.policy')}</th>
                      <th scope="col">{t('adm.common.from')}</th>
                      <th scope="col" className={numClass}>
                        {t('adm.to.balance')}
                      </th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((a) => (
                      <AssignmentRow key={a.id} a={a} onChanged={refresh} />
                    ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
        <p className="small muted">{t('adm.to.footer')}</p>
      </Card>
    </>
  );
}
