'use client';

import { useState, type FormEvent } from 'react';
import {
  PAYROLL_ADJUSTMENT_KINDS,
  PAYROLL_ADJUSTMENT_LABELS,
  type BillRateDTO,
  type BudgetKind,
  type BudgetResets,
  type PayRateDTO,
  type PayrollAdjustmentDTO,
  type PayrollAdjustmentKind,
  type ProjectBudgetDTO,
  type ProjectDTO,
  type UserDTO,
} from '@rd/contracts';
import { BudgetMeter } from '@/components/BudgetMeter';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Banner, Card, PageHeader, formActionsClass, formGridClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, formatMoney, formatPercent } from '@/lib/format';
import { useMe } from '@/lib/me';
import { CURRENCIES, adjustmentWhen, centsToInput, formatRate, latestBy, parseHoursInput, parseMoneyInput, parseThresholds } from '@/lib/money';
import { formatDayLabel, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { MoneyGate } from '../MoneyGate';
import s from '../admin.module.css';
import m from '../money.module.css';

function CurrencyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SelectField label="Currency" value={value} onChange={(e) => onChange(e.target.value)}>
      {CURRENCIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </SelectField>
  );
}

/** Amount, currency and start date — shared by pay and bill rate forms. */
function useRateFields(today: string) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [from, setFrom] = useState(today);
  const cents = parseMoneyInput(amount);
  const fields = (
    <>
      <TextField
        label="Hourly rate"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={amount && cents === null ? 'Enter an amount such as 45 or 45.50' : null}
      />
      <CurrencyField value={currency} onChange={setCurrency} />
      <TextField label="Starts on" type="date" value={from} onChange={(e) => setFrom(e.target.value)} hint="Earlier time keeps its earlier rate" />
    </>
  );
  return { fields, cents, currency, from, reset: () => setAmount('') };
}

function RateHistory<T extends PayRateDTO | BillRateDTO>({
  rows,
  today,
  label,
  onDelete,
  busy,
}: {
  rows: T[];
  today: string;
  label: (r: T) => string;
  onDelete: (r: T) => void;
  busy: boolean;
}) {
  return (
    <ul className={m.history}>
      {rows.map((r) => (
        <li key={r.id}>
          <span>
            {label(r)} <span className={m.amount}>{formatRate(r.amount_cents, r.currency)}</span> from {formatDayLabel(r.effective_from)}
            {r.effective_from > today ? ' (scheduled)' : ''}
          </span>
          {r.effective_from > today ? (
            <Button size="sm" variant="quiet" onClick={() => onDelete(r)} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────── pay rates ─────────────────────────

function PayRates({ users, today }: { users: UserDTO[]; today: string }) {
  // Loaded on request only: every load is recorded in each person's access log.
  const [shown, setShown] = useState(false);
  const rates = useApi(shown ? 'money:pay' : null, (signal) => rd.money.payRates(signal));
  const action = useAction();
  const [userId, setUserId] = useState('');
  const f = useRateFields(today);
  const people = users.filter((u) => u.status === 'active').sort(byName);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || f.cents === null) return;
    const r = await action.run(() => rd.money.createPayRate({ user_id: userId, amount_cents: f.cents!, currency: f.currency, effective_from: f.from }));
    if (r) {
      f.reset();
      if (shown) rates.reload();
      else setShown(true);
    }
  };
  const remove = async (r: PayRateDTO) => {
    if (await action.run(() => rd.money.deletePayRate(r.id))) rates.reload();
  };

  return (
    <Card title="Pay rates" subtitle="What each person is paid per hour">
      <Banner tag="PRIVATE">
        Each person sees only their own pay rate. Viewing this list is recorded in each person&apos;s access log, and every change is audited.
      </Banner>
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person…</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </SelectField>
          {f.fields}
        </div>
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={!userId || f.cents === null || action.busy}>
            Add pay rate
          </Button>
        </div>
      </form>
      <ActionError error={action.error} />
      {!shown ? (
        <div>
          <Button onClick={() => setShown(true)}>Show pay rates</Button>
        </div>
      ) : (
        <Resource {...rates} label="Loading pay rates">
          {(list) => {
            if (list.length === 0) return <Empty title="No pay rates yet" />;
            const current = latestBy(list, (r) => r.user_id, today);
            const byUser = new Map<string, PayRateDTO[]>();
            for (const r of list) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
            return (
              <ul className={s.list}>
                {[...byUser.entries()]
                  .sort((a, b) => a[1][0]!.user_name.localeCompare(b[1][0]!.user_name))
                  .map(([uid, rows]) => {
                    const cur = current.get(uid);
                    return (
                      <li key={uid} className={s.item}>
                        <details>
                          <summary>
                            <span className={s.summaryName}>{rows[0]!.user_name}</span>
                            <span className={m.amount}>
                              {cur ? `${formatRate(cur.amount_cents, cur.currency)} since ${formatDayLabel(cur.effective_from)}` : 'Starts later'}
                            </span>
                          </summary>
                          <div className={s.detail}>
                            <RateHistory rows={rows} today={today} label={() => ''} onDelete={remove} busy={action.busy} />
                          </div>
                        </details>
                      </li>
                    );
                  })}
              </ul>
            );
          }}
        </Resource>
      )}
    </Card>
  );
}

// ───────────────────────── payroll adjustments ─────────────────────────

/** Bonuses, deductions and reimbursements (F8): their own columns in the payroll file. */
function PayAdjustments({ users, today }: { users: UserDTO[]; today: string }) {
  // Loaded on request, like pay rates: every load is recorded in each person's access log.
  const [shown, setShown] = useState(false);
  const list = useApi(shown ? 'money:adjustments' : null, (signal) => rd.money.adjustments(signal));
  const action = useAction();
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState<PayrollAdjustmentKind>('bonus');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [recurrence, setRecurrence] = useState<PayrollAdjustmentDTO['recurrence']>('once');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const people = users.filter((u) => u.status === 'active').sort(byName);
  const cents = parseMoneyInput(amount);
  const badEnd = recurrence === 'every_period' && to !== '' && to < from;
  const ready = userId && cents !== null && cents >= 1 && note.trim() && from && !badEnd;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || cents === null) return;
    const r = await action.run(() =>
      rd.money.createAdjustment({
        user_id: userId,
        kind,
        amount_cents: cents,
        currency,
        note: note.trim(),
        recurrence,
        effective_from: from,
        effective_to: recurrence === 'every_period' && to ? to : null,
      }),
    );
    if (!r) return;
    setAmount('');
    setNote('');
    setTo('');
    if (shown) list.reload();
    else setShown(true);
  };
  const end = async (a: PayrollAdjustmentDTO) => {
    if (await action.run(() => rd.money.endAdjustment(a.id, today))) list.reload();
  };
  const remove = async (a: PayrollAdjustmentDTO) => {
    if (await action.run(() => rd.money.deleteAdjustment(a.id))) list.reload();
  };

  return (
    <Card title="Bonuses and deductions" subtitle="One-off or every pay period, on top of hours × rate">
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person…</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </SelectField>
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as PayrollAdjustmentKind)}>
            {PAYROLL_ADJUSTMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {PAYROLL_ADJUSTMENT_LABELS[k]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={amount && (cents === null || cents < 1) ? 'Enter an amount such as 500 or 49.99' : null}
          />
          <CurrencyField value={currency} onChange={setCurrency} />
          <SelectField label="How often" value={recurrence} onChange={(e) => setRecurrence(e.target.value as PayrollAdjustmentDTO['recurrence'])}>
            <option value="once">Once</option>
            <option value="every_period">Every pay period</option>
          </SelectField>
          <TextField
            label={recurrence === 'once' ? 'In the pay period with' : 'From'}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          {recurrence === 'every_period' ? (
            <TextField
              label="Until (optional)"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              error={badEnd ? 'The end date is before the start date.' : null}
            />
          ) : null}
        </div>
        <TextArea label="Note" hint="The person sees this, e.g. “Q3 bonus” or “Parking”" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={!ready || action.busy}>
            Add {PAYROLL_ADJUSTMENT_LABELS[kind].toLowerCase()}
          </Button>
        </div>
      </form>
      <ActionError error={action.error} />
      {!shown ? (
        <div>
          <Button onClick={() => setShown(true)}>Show bonuses and deductions</Button>
        </div>
      ) : (
        <Resource {...list} label="Loading bonuses and deductions">
          {(rows) =>
            rows.length === 0 ? (
              <Empty title="None yet" />
            ) : (
              <ul className={m.history}>
                {rows.map((a) => {
                  const ended = a.recurrence === 'every_period' && a.effective_to !== null && a.effective_to < today;
                  return (
                    <li key={a.id}>
                      <span>
                        <strong>{a.user_name}</strong> · {PAYROLL_ADJUSTMENT_LABELS[a.kind]}{' '}
                        <span className={m.amount}>
                          {a.kind === 'deduction' ? '−' : ''}
                          {formatMoney(a.amount_cents, a.currency)}
                        </span>{' '}
                        · {a.note}
                        <span className="small muted" style={{ display: 'block' }}>
                          {adjustmentWhen(a)}
                          {ended ? ' · ended' : ''}
                        </span>
                      </span>
                      {a.recurrence === 'once' || a.effective_from > today ? (
                        <Button size="sm" variant="quiet" onClick={() => remove(a)} disabled={action.busy}>
                          Remove
                        </Button>
                      ) : !a.effective_to || a.effective_to > today ? (
                        <Button size="sm" variant="quiet" onClick={() => end(a)} disabled={action.busy}>
                          End today
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )
          }
        </Resource>
      )}
    </Card>
  );
}

// ───────────────────────── bill rates ─────────────────────────

function BillRates({ users, projects, today }: { users: UserDTO[]; projects: ProjectDTO[]; today: string }) {
  const rates = useApi('money:bill', (signal) => rd.money.billRates(signal));
  const action = useAction();
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const f = useRateFields(today);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || f.cents === null) return;
    const r = await action.run(() =>
      rd.money.createBillRate({ project_id: projectId, user_id: userId || null, amount_cents: f.cents!, currency: f.currency, effective_from: f.from }),
    );
    if (r) {
      f.reset();
      rates.reload();
    }
  };
  const remove = async (r: BillRateDTO) => {
    if (await action.run(() => rd.money.deleteBillRate(r.id))) rates.reload();
  };
  return (
    <Card title="Bill rates" subtitle="What clients are charged per hour, per project">
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Choose a project…</option>
            {[...projects]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </SelectField>
          <SelectField label="For" value={userId} onChange={(e) => setUserId(e.target.value)} hint="A person's own rate overrides the project default">
            <option value="">Everyone (project default)</option>
            {users
              .filter((u) => u.status === 'active')
              .sort(byName)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name}
                </option>
              ))}
          </SelectField>
          {f.fields}
        </div>
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={!projectId || f.cents === null || action.busy}>
            Add bill rate
          </Button>
        </div>
      </form>
      <ActionError error={action.error} />
      <Resource {...rates} label="Loading bill rates">
        {(list) => {
          if (list.length === 0) return <Empty title="No bill rates yet" />;
          const byProject = new Map<string, BillRateDTO[]>();
          for (const r of list) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
          return (
            <ul className={s.list}>
              {[...byProject.entries()]
                .sort((a, b) => a[1][0]!.project_name.localeCompare(b[1][0]!.project_name))
                .map(([pid, rows]) => {
                  const def = latestBy(
                    rows.filter((r) => !r.user_id),
                    () => 'default',
                    today,
                  ).get('default');
                  const people = new Set(rows.filter((r) => r.user_id).map((r) => r.user_id)).size;
                  return (
                    <li key={pid} className={s.item}>
                      <details>
                        <summary>
                          <span className={s.summaryName}>{rows[0]!.project_name}</span>
                          <span className="small muted">
                            {def ? `Default ${formatRate(def.amount_cents, def.currency)}` : 'No default rate'}
                            {people ? ` · ${people} personal ${people === 1 ? 'rate' : 'rates'}` : ''}
                          </span>
                        </summary>
                        <div className={s.detail}>
                          <RateHistory
                            rows={rows}
                            today={today}
                            label={(r) => `${r.user_name ?? 'Everyone'}:`}
                            onDelete={remove}
                            busy={action.busy}
                          />
                        </div>
                      </details>
                    </li>
                  );
                })}
            </ul>
          );
        }}
      </Resource>
    </Card>
  );
}

// ───────────────────────── budgets ─────────────────────────

function BudgetForm({ projectId, initial, onSaved }: { projectId: string; initial?: ProjectBudgetDTO; onSaved: () => void }) {
  const action = useAction();
  const [kind, setKind] = useState<BudgetKind>(initial?.kind ?? 'hours');
  const [limit, setLimit] = useState(
    initial ? (initial.kind === 'hours' ? String(initial.limit_hours ?? '') : centsToInput(initial.limit_cents ?? 0)) : '',
  );
  const [currency, setCurrency] = useState(initial?.currency ?? 'USD');
  const [thresholds, setThresholds] = useState((initial?.alert_thresholds ?? [80, 100]).join(', '));
  const [stop, setStop] = useState(initial?.stop_at_budget ?? false);
  const [resets, setResets] = useState<BudgetResets>(initial?.resets ?? 'never');
  const limitValue = kind === 'hours' ? parseHoursInput(limit) : parseMoneyInput(limit);
  const parsedThresholds = parseThresholds(thresholds);
  const valid = limitValue !== null && limitValue > 0 && parsedThresholds !== null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const r = await action.run(() =>
      rd.money.putBudget(projectId, {
        kind,
        ...(kind === 'hours' ? { limit_hours: limitValue! } : { limit_cents: limitValue!, currency }),
        alert_thresholds: parsedThresholds!,
        stop_at_budget: stop,
        resets,
      }),
    );
    if (r) onSaved();
  };
  const remove = async () => {
    if (await action.run(() => rd.money.deleteBudget(projectId))) onSaved();
  };
  return (
    <form onSubmit={submit} className={m.stack}>
      <div className={formGridClass}>
        <SelectField label="Budget in" value={kind} onChange={(e) => setKind(e.target.value as BudgetKind)}>
          <option value="hours">Hours</option>
          <option value="amount">Amount (at bill rates)</option>
        </SelectField>
        <TextField
          label={kind === 'hours' ? 'Limit (hours)' : 'Limit (amount)'}
          inputMode="decimal"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          error={limit && (limitValue === null || limitValue <= 0) ? 'Enter a positive number' : null}
        />
        {kind === 'amount' ? <CurrencyField value={currency} onChange={setCurrency} /> : null}
        <SelectField label="Resets" value={resets} onChange={(e) => setResets(e.target.value as BudgetResets)}>
          <option value="never">Never (whole project)</option>
          <option value="monthly">Every month</option>
        </SelectField>
        <TextField
          label="Alert at (%)"
          value={thresholds}
          onChange={(e) => setThresholds(e.target.value)}
          hint="Org admins and project managers are notified once per threshold"
          error={parsedThresholds === null ? 'Whole percentages separated by commas, e.g. 80, 100' : null}
        />
      </div>
      <Checkbox
        label="Stop at budget"
        checked={stop}
        onChange={(e) => setStop(e.target.checked)}
        hint="At 100%, nobody can start a new session on this project. Sessions already running are never stopped."
      />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        {initial ? (
          <Button variant="quiet" onClick={remove} disabled={action.busy}>
            Remove budget
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={!valid || action.busy}>
          {initial ? 'Save budget' : 'Set budget'}
        </Button>
      </div>
    </form>
  );
}

function Budgets({ projects }: { projects: ProjectDTO[] }) {
  const budgets = useApi('money:budgets', (signal) => rd.money.budgets(signal));
  const [newFor, setNewFor] = useState('');
  const withBudget = new Set((budgets.data ?? []).map((b) => b.project_id));
  const without = projects.filter((p) => !withBudget.has(p.id) && p.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Card title="Project budgets" subtitle="Hours or amount; usage includes agent-tracked and approved manual time">
      <Resource {...budgets} label="Loading budgets">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No budgets yet" />
          ) : (
            <ul className={s.list}>
              {list.map((b) => (
                <li key={b.project_id} className={s.item}>
                  <details>
                    <summary>
                      <span className={s.summaryName}>{b.project_name}</span>
                      <span className="small muted">{formatPercent(b.used_percent, 1)} used</span>
                    </summary>
                    <div className={s.detail}>
                      <BudgetMeter budget={b} />
                      <BudgetForm projectId={b.project_id} initial={b} onSaved={budgets.reload} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )
        }
      </Resource>
      <div className={m.stack}>
        <SelectField label="Set a budget for" value={newFor} onChange={(e) => setNewFor(e.target.value)}>
          <option value="">Choose a project…</option>
          {without.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>
        {newFor ? (
          <BudgetForm
            key={newFor}
            projectId={newFor}
            onSaved={() => {
              setNewFor('');
              budgets.reload();
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

function RatesContent() {
  const { timezone: tz } = useMe();
  const today = todayInTz(tz);
  const users = useApi('admin:users', (signal) => rd.admin.users(signal));
  const projects = useApi('admin:projects', (signal) => rd.admin.projects(signal));
  return (
    <>
      <PageHeader
        eyebrow="Admin · Money"
        title="Rates and budgets"
        description="Rates are effective-dated: a change starts on a date and earlier time keeps its earlier rate. Each session uses the rate in effect on the day it started."
      />
      <PayRates users={users.data ?? []} today={today} />
      <PayAdjustments users={users.data ?? []} today={today} />
      <BillRates users={users.data ?? []} projects={projects.data ?? []} today={today} />
      <Budgets projects={projects.data ?? []} />
      <Banner tag="PAYROLL" actions={<ButtonLink href="/money" size="sm">Open period close</ButtonLink>}>
        Payroll export is on Period close, next to this period&apos;s approved hours.
      </Banner>
    </>
  );
}

export default function RatesPage() {
  return (
    <MoneyGate title="Rates and budgets">
      <RatesContent />
    </MoneyGate>
  );
}
