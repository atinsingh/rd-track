'use client';

import { useState, type FormEvent } from 'react';
import {
  PAYROLL_ADJUSTMENT_KINDS,
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
import { CURRENCIES, adjustmentWhen, centsToInput, decimalToInput, formatRate, latestBy, parseHoursInput, parseMoneyInput, parseThresholds } from '@/lib/money';
import { formatDayLabel, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import { MoneyGate } from '../MoneyGate';
import s from '../admin.module.css';
import m from '../money.module.css';

function CurrencyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SelectField label={t('money.rates.currency')} value={value} onChange={(e) => onChange(e.target.value)}>
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
        label={t('money.rates.hourly')}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={amount && cents === null ? t('money.rates.hourlyInvalid') : null}
      />
      <CurrencyField value={currency} onChange={setCurrency} />
      <TextField
        label={t('money.rates.startsOn')}
        type="date"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        hint={t('money.rates.startsHint')}
      />
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
            {label(r)} <span className={m.amount}>{formatRate(r.amount_cents, r.currency)}</span>{' '}
            {t('money.rates.fromDate', { date: formatDayLabel(r.effective_from) })}
            {r.effective_from > today ? t('money.rates.scheduled') : ''}
          </span>
          {r.effective_from > today ? (
            <Button size="sm" variant="quiet" onClick={() => onDelete(r)} disabled={busy}>
              {t('money.rates.cancel')}
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
    <Card title={t('money.rates.payTitle')} subtitle={t('money.rates.paySub')}>
      <Banner tag="PRIVATE">{t('money.rates.payPrivate')}</Banner>
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label={t('money.rates.person')} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('money.rates.choosePerson')}</option>
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
            {t('money.rates.addPay')}
          </Button>
        </div>
      </form>
      <ActionError error={action.error} />
      {!shown ? (
        <div>
          <Button onClick={() => setShown(true)}>{t('money.rates.showPay')}</Button>
        </div>
      ) : (
        <Resource {...rates} label={t('money.rates.loadingPay')}>
          {(list) => {
            if (list.length === 0) return <Empty title={t('money.rates.noPay')} />;
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
                              {cur
                                ? t('money.rates.since', { rate: formatRate(cur.amount_cents, cur.currency), date: formatDayLabel(cur.effective_from) })
                                : t('money.rates.startsLater')}
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
    <Card title={t('money.rates.adjTitle')} subtitle={t('money.rates.adjSub')}>
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label={t('money.rates.person')} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('money.rates.choosePerson')}</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('money.rates.kind')} value={kind} onChange={(e) => setKind(e.target.value as PayrollAdjustmentKind)}>
            {PAYROLL_ADJUSTMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`pay.kind.${k}`)}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('money.rates.amount')}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={amount && (cents === null || cents < 1) ? t('money.rates.amountInvalid') : null}
          />
          <CurrencyField value={currency} onChange={setCurrency} />
          <SelectField
            label={t('money.rates.howOften')}
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as PayrollAdjustmentDTO['recurrence'])}
          >
            <option value="once">{t('money.rates.once')}</option>
            <option value="every_period">{t('money.rates.every')}</option>
          </SelectField>
          <TextField
            label={recurrence === 'once' ? t('money.rates.inPeriodWith') : t('money.rates.fromLabel')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          {recurrence === 'every_period' ? (
            <TextField
              label={t('money.rates.untilOptional')}
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              error={badEnd ? t('money.rates.endBefore') : null}
            />
          ) : null}
        </div>
        <TextArea
          label={t('money.rates.note')}
          hint={t('money.rates.noteHint')}
          rows={2}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={!ready || action.busy}>
            {t(`money.rates.add.${kind}`)}
          </Button>
        </div>
      </form>
      <ActionError error={action.error} />
      {!shown ? (
        <div>
          <Button onClick={() => setShown(true)}>{t('money.rates.showAdj')}</Button>
        </div>
      ) : (
        <Resource {...list} label={t('money.rates.loadingAdj')}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty title={t('money.rates.noneYet')} />
            ) : (
              <ul className={m.history}>
                {rows.map((a) => {
                  const ended = a.recurrence === 'every_period' && a.effective_to !== null && a.effective_to < today;
                  return (
                    <li key={a.id}>
                      <span>
                        <strong>{a.user_name}</strong> · {t(`pay.kind.${a.kind}`)}{' '}
                        <span className={m.amount}>
                          {a.kind === 'deduction' ? '−' : ''}
                          {formatMoney(a.amount_cents, a.currency)}
                        </span>{' '}
                        · {a.note}
                        <span className="small muted" style={{ display: 'block' }}>
                          {adjustmentWhen(a)}
                          {ended ? t('money.rates.ended') : ''}
                        </span>
                      </span>
                      {a.recurrence === 'once' || a.effective_from > today ? (
                        <Button size="sm" variant="quiet" onClick={() => remove(a)} disabled={action.busy}>
                          {t('money.rates.remove')}
                        </Button>
                      ) : !a.effective_to || a.effective_to > today ? (
                        <Button size="sm" variant="quiet" onClick={() => end(a)} disabled={action.busy}>
                          {t('money.rates.endToday')}
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
    <Card title={t('money.rates.billTitle')} subtitle={t('money.rates.billSub')}>
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <SelectField label={t('money.rates.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t('money.rates.chooseProject')}</option>
            {[...projects]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </SelectField>
          <SelectField label={t('money.rates.for')} value={userId} onChange={(e) => setUserId(e.target.value)} hint={t('money.rates.forHint')}>
            <option value="">{t('money.rates.everyoneDefault')}</option>
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
            {t('money.rates.addBill')}
          </Button>
        </div>
      </form>
      <ActionError error={action.error} />
      <Resource {...rates} label={t('money.rates.loadingBill')}>
        {(list) => {
          if (list.length === 0) return <Empty title={t('money.rates.noBill')} />;
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
                            {def ? t('money.rates.default', { rate: formatRate(def.amount_cents, def.currency) }) : t('money.rates.noDefault')}
                            {people ? tPlural(people, 'money.rates.personal.one', 'money.rates.personal.other') : ''}
                          </span>
                        </summary>
                        <div className={s.detail}>
                          <RateHistory
                            rows={rows}
                            today={today}
                            label={(r) => t('money.rates.who', { name: r.user_name ?? t('money.rates.everyone') })}
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
    initial ? (initial.kind === 'hours' ? decimalToInput(initial.limit_hours ?? 0, Number.isInteger(initial.limit_hours ?? 0) ? 0 : 2) : centsToInput(initial.limit_cents ?? 0)) : '',
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
        <SelectField label={t('money.rates.budgetIn')} value={kind} onChange={(e) => setKind(e.target.value as BudgetKind)}>
          <option value="hours">{t('money.rates.hoursOpt')}</option>
          <option value="amount">{t('money.rates.amountOpt')}</option>
        </SelectField>
        <TextField
          label={kind === 'hours' ? t('money.rates.limitHours') : t('money.rates.limitAmount')}
          inputMode="decimal"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          error={limit && (limitValue === null || limitValue <= 0) ? t('money.rates.positive') : null}
        />
        {kind === 'amount' ? <CurrencyField value={currency} onChange={setCurrency} /> : null}
        <SelectField label={t('money.rates.resets')} value={resets} onChange={(e) => setResets(e.target.value as BudgetResets)}>
          <option value="never">{t('money.rates.never')}</option>
          <option value="monthly">{t('money.rates.monthly')}</option>
        </SelectField>
        <TextField
          label={t('money.rates.alertAt')}
          value={thresholds}
          onChange={(e) => setThresholds(e.target.value)}
          hint={t('money.rates.alertHint')}
          error={parsedThresholds === null ? t('money.rates.alertInvalid') : null}
        />
      </div>
      <Checkbox label={t('money.rates.stop')} checked={stop} onChange={(e) => setStop(e.target.checked)} hint={t('money.rates.stopHint')} />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        {initial ? (
          <Button variant="quiet" onClick={remove} disabled={action.busy}>
            {t('money.rates.removeBudget')}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={!valid || action.busy}>
          {initial ? t('money.rates.saveBudget') : t('money.rates.setBudget')}
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
    <Card title={t('money.rates.budgetsTitle')} subtitle={t('money.rates.budgetsSub')}>
      <Resource {...budgets} label={t('money.rates.loadingBudgets')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('money.rates.noBudgets')} />
          ) : (
            <ul className={s.list}>
              {list.map((b) => (
                <li key={b.project_id} className={s.item}>
                  <details>
                    <summary>
                      <span className={s.summaryName}>{b.project_name}</span>
                      <span className="small muted">{t('money.rates.used', { pct: formatPercent(b.used_percent, 1) })}</span>
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
        <SelectField label={t('money.rates.setFor')} value={newFor} onChange={(e) => setNewFor(e.target.value)}>
          <option value="">{t('money.rates.chooseProject')}</option>
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
        eyebrow={t('money.rates.eyebrow')}
        title={t('money.rates.title')}
        description={t('money.rates.description')}
      />
      <PayRates users={users.data ?? []} today={today} />
      <PayAdjustments users={users.data ?? []} today={today} />
      <BillRates users={users.data ?? []} projects={projects.data ?? []} today={today} />
      <Budgets projects={projects.data ?? []} />
      <Banner
        tag="PAYROLL"
        actions={
          <ButtonLink href="/money" size="sm">
            {t('money.rates.openClose')}
          </ButtonLink>
        }
      >
        {t('money.rates.payrollNote')}
      </Banner>
    </>
  );
}

export default function RatesPage() {
  return (
    <MoneyGate title={t('money.rates.title')}>
      <RatesContent />
    </MoneyGate>
  );
}
