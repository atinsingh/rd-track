'use client';

import { useState, type FormEvent } from 'react';
import type { TimeOffAccrual, TimeOffAssignmentDTO, TimeOffPolicyDTO, UserDTO } from '@rd/contracts';
import s from '@/components/scheduling/scheduling.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName } from '@/lib/format';
import { useMe } from '@/lib/me';
import { accrualLabel, formatHours, sched } from '@/lib/scheduling';
import { formatShortDay, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

const optionalNumber = (v: string): number | null => (v.trim() === '' ? null : Number(v));

function PolicyForm({ onCreated }: { onCreated: (p: TimeOffPolicyDTO) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'paid' | 'unpaid'>('paid');
  const [accrual, setAccrual] = useState<TimeOffAccrual>('per_month');
  const [hours, setHours] = useState('10');
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
        <TextField label="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Vacation" required />
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as 'paid' | 'unpaid')}>
          <option value="paid">Paid (uses a balance)</option>
          <option value="unpaid">Unpaid (no balance)</option>
        </SelectField>
        <SelectField label="Accrual" value={accrual} onChange={(e) => setAccrual(e.target.value as TimeOffAccrual)}>
          <option value="none">None (set balances by hand)</option>
          <option value="per_month">Every month</option>
          <option value="per_year">Every year</option>
        </SelectField>
        {accrual !== 'none' ? (
          <TextField label="Hours each time" type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} required />
        ) : null}
        <TextField label="Maximum balance (hours)" hint="Optional; accrual stops at this" type="number" min={0} step={0.5} value={max} onChange={(e) => setMax(e.target.value)} />
        <TextField label="Carryover (hours)" hint="Optional; hours above this expire on 1 January" type="number" min={0} step={0.5} value={carry} onChange={(e) => setCarry(e.target.value)} />
      </div>
      <Checkbox label="Allow a negative balance" hint="Requests can go below zero; otherwise they need enough hours." checked={negative} onChange={(e) => setNegative(e.target.checked)} />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button type="submit" variant="primary" disabled={!name.trim() || action.busy}>
          Create policy
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
      <SelectField label="Policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)} required>
        <option value="">Choose a policy…</option>
        {policies.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>
      <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} required>
        <option value="">Choose a person…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name}
          </option>
        ))}
      </SelectField>
      <TextField label="From" type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
      <TextField label="Opening balance (hours)" type="number" step={0.5} value={opening} onChange={(e) => setOpening(e.target.value)} />
      <Button type="submit" disabled={!policyId || !userId || action.busy}>
        Assign
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
              Adjust
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={action.busy}
              aria-label={`Remove ${a.user_name} from ${a.policy_name}`}
              onClick={async () => {
                if (await action.run(() => sched.admin.unassign(a.id))) onChanged();
              }}
            >
              Remove
            </Button>
          </span>
        </td>
      </tr>
      {open || action.error ? (
        <tr>
          <td colSpan={5}>
            {open ? (
              <form onSubmit={adjust} className={s.inlineForm}>
                <TextField label="Hours (+ or −)" type="number" step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} required />
                <TextField label="Note (shown to the person)" value={note} minLength={3} maxLength={500} onChange={(e) => setNote(e.target.value)} required />
                <Button type="submit" disabled={!hours || Number(hours) === 0 || note.trim().length < 3 || action.busy}>
                  Save adjustment
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

  if (!access.isAdmin) return <NoAccess what="Time-off policies are managed by org admins." />;
  if (!enabled) return <NoAccess what="Time off is part of the Standard and Pro plans. An org admin can change the plan in Billing." />;
  const people = [...(users.data ?? [])].filter((u) => u.status === 'active').sort(byName);
  const active = (policies.data ?? []).filter((p) => !p.archived);
  const refresh = () => {
    policies.reload();
    assignments.reload();
  };

  return (
    <>
      <PageHeader
        eyebrow="Admin · Time off"
        title="Time-off policies"
        description="Policies decide how time off accrues. People request time off; their team managers (or an org admin) approve it, and approved hours come off the balance."
      />
      <Card title="New policy">
        <PolicyForm onCreated={(p) => policies.mutate((prev) => [...(prev ?? []), p])} />
      </Card>
      <Card title="Policies">
        <ActionError error={archive.error} />
        <Resource {...policies} label="Loading policies">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No policies yet" />
            ) : (
              <TableBox label="Time-off policies">
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Accrual</th>
                      <th scope="col">Limits</th>
                      <th scope="col" className={numClass}>
                        People
                      </th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.name} {p.archived ? <Badge>Archived</Badge> : null}
                        </td>
                        <td>{p.kind === 'paid' ? 'Paid' : 'Unpaid'}</td>
                        <td>{accrualLabel(p)}</td>
                        <td className="small secondary">
                          {[
                            p.max_balance_hours !== null ? `max ${formatHours(p.max_balance_hours)}` : null,
                            p.carryover_hours !== null ? `carry over ${formatHours(p.carryover_hours)}` : null,
                            p.allow_negative ? 'may go negative' : null,
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
                            {p.archived ? 'Restore' : 'Archive'}
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
      <Card title="Who is on which policy">
        {active.length > 0 ? <AssignForm policies={active} users={people} onAssigned={() => assignments.reload()} /> : null}
        <Resource {...assignments} label="Loading assignments">
          {(list) =>
            list.length === 0 ? (
              <Empty title="Nobody is on a policy yet" />
            ) : (
              <TableBox label="Assignments">
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Policy</th>
                      <th scope="col">From</th>
                      <th scope="col" className={numClass}>
                        Balance
                      </th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
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
        <p className="small muted">Accruals run automatically each month or year. Every change to a balance is in the person&apos;s balance history and the audit log.</p>
      </Card>
    </>
  );
}
