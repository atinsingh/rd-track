'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { BillRateDTO, BudgetKind, BudgetResets, PayRateDTO, PayrollExportDTO, ProjectBudgetDTO, ProjectDTO, UserDTO } from '@rd/contracts';
import { BudgetMeter } from '@/components/BudgetMeter';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError } from '@/lib/api';
import { byName } from '@/lib/format';
import { useMe } from '@/lib/me';
import { CURRENCIES, centsToInput, formatRate, latestBy, parseHoursInput, parseMoneyInput, parseThresholds } from '@/lib/money';
import { addDays, formatDateTime, formatDayLabel, startOfMonth, todayInTz } from '@/lib/time';
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
                      <span className="small muted">{b.used_percent.toFixed(1)}% used</span>
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

// ───────────────────────── payroll ─────────────────────────

const EXPORT_STATUS: Record<PayrollExportDTO['status'], string> = {
  queued: 'Queued',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

function PayrollDownload({ e }: { e: PayrollExportDTO }) {
  const [error, setError] = useState<ApiError | null>(null);
  if (e.status !== 'ready') return null;
  const fetchLink = async () => {
    try {
      const fresh = await rd.money.payrollExport(e.id);
      if (fresh.download_url) window.location.assign(fresh.download_url);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  return (
    <>
      <Button size="sm" variant="quiet" onClick={fetchLink}>
        Download CSV
      </Button>
      <ActionError error={error} />
    </>
  );
}

function Payroll({ tz, today }: { tz: string; today: string }) {
  const exportsRes = useApi('money:payroll', (signal) => rd.money.payrollExports(signal));
  const create = useAction();
  const [from, setFrom] = useState(() => startOfMonth(addDays(startOfMonth(today), -1)));
  const [to, setTo] = useState(() => addDays(startOfMonth(today), -1));
  const inFlight = (exportsRes.data ?? []).some((e) => e.status === 'queued' || e.status === 'running');
  const { reload } = exportsRes;
  useEffect(() => {
    if (!inFlight) return;
    const t = window.setInterval(reload, 3000);
    return () => window.clearInterval(t);
  }, [inFlight, reload]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (from > to) return;
    const r = await create.run(() => rd.money.createPayrollExport({ period_from: from, period_to: to, timezone: tz }));
    if (r) exportsRes.mutate((prev) => [r, ...(prev ?? [])]);
  };
  return (
    <Card title="Payroll export" subtitle="Hours × pay rate per person for a pay period, as CSV">
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <TextField label="Pay period from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            hint={`Whole days in ${tz}; up to 93 days`}
            error={from > to ? 'The end date is before the start date.' : null}
          />
        </div>
        <p className="small muted">
          Uses all recorded time (agent-tracked and approved manual time). Hours are rounded to the minute, then to two decimals. Files expire after 24
          hours; each download is recorded in the access log of everyone in the file.
        </p>
        <ActionError error={create.error} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={create.busy || from > to}>
            {create.busy ? 'Queuing…' : 'Create payroll export →'}
          </Button>
        </div>
      </form>
      <Resource {...exportsRes} label="Loading payroll exports">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No payroll exports yet" />
          ) : (
            <TableBox label="Payroll exports">
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">Created</th>
                    <th scope="col">Pay period</th>
                    <th scope="col">Status</th>
                    <th scope="col" className={numClass}>
                      Rows
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDateTime(e.created_at, tz)}</td>
                      <td>
                        {formatDayLabel(e.period_from)} – {formatDayLabel(e.period_to)}
                      </td>
                      <td>
                        <Badge tone={e.status === 'ready' ? 'solid' : 'outline'}>{EXPORT_STATUS[e.status]}</Badge>
                      </td>
                      <td className={numClass}>{e.row_count ?? '—'}</td>
                      <td>
                        <PayrollDownload e={e} />
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
      <BillRates users={users.data ?? []} projects={projects.data ?? []} today={today} />
      <Budgets projects={projects.data ?? []} />
      <Payroll tz={tz} today={today} />
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
