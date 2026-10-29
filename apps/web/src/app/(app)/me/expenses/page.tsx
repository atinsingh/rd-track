'use client';

import { useState, type FormEvent } from 'react';
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory, type ExpenseDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { Checkbox, InlineSelect, SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { claimMeta, claimStatus, claimsFrom, receiptProblem, totalCount, totalText, type ClaimRange } from '@/lib/expenses';
import { formatMoney } from '@/lib/format';
import { useMe } from '@/lib/me';
import { CURRENCIES, parseMoneyInput } from '@/lib/money';
import { can } from '@/lib/nav';
import { formatDayMonth, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from './expenses.module.css';

function NewClaim({ today, currency: defaultCurrency, onCreated }: { today: string; currency: string; onCreated: (e: ExpenseDTO) => void }) {
  const projects = useApi('me:projects', (signal) => rd.my.projects(signal));
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [spentOn, setSpentOn] = useState(today);
  const [category, setCategory] = useState<ExpenseCategory>('travel');
  const [projectId, setProjectId] = useState('');
  const [billable, setBillable] = useState(true);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const action = useAction();

  const cents = parseMoneyInput(amount);
  const project = projects.data?.find((p) => p.id === projectId) ?? null;
  const canBill = Boolean(project?.client_name);
  const amountError = amount && (cents === null || cents < 1 || cents > 10_000_000) ? 'Enter an amount like 34.50, up to 100,000.' : null;
  const ready = cents !== null && cents >= 1 && !amountError && note.trim().length > 0 && spentOn <= today && !fileError;
  const currencies = (CURRENCIES as readonly string[]).includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];

  const pick = (f: File | null) => {
    setFile(f);
    setFileError(f ? receiptProblem(f) : null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || cents === null) return;
    const created = await action.run(async () => {
      let receiptId: string | undefined;
      if (file) {
        // The receipt goes straight to private storage; the API checks it arrived before saving the claim.
        const up = await rd.expenses.receiptUpload(file.type, file.size);
        const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: file }).catch(() => null);
        if (!put?.ok) throw new Error('The receipt didn’t upload. Try again.');
        receiptId = up.upload_id;
      }
      return rd.expenses.create({
        amount_cents: cents,
        currency,
        spent_on: spentOn,
        category,
        project_id: projectId || null,
        billable: canBill && billable,
        note: note.trim(),
        receipt_upload_id: receiptId,
      });
    });
    if (!created) return;
    onCreated(created);
    setAmount('');
    setNote('');
    pick(null);
    setInputKey((k) => k + 1);
  };

  return (
    <Card title="New claim" className={s.form}>
      <form onSubmit={submit} className={s.formBody}>
        <div className={s.pair}>
          <TextField label="Amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} error={amountError} />
          <SelectField label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </SelectField>
        </div>
        <div className={s.pair}>
          <TextField label="Date" type="date" max={today} value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
        </div>
        <SelectField label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Internal · no project</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.client_name ? `${p.client_name} — ${p.name}` : p.name}
            </option>
          ))}
        </SelectField>
        {canBill ? (
          <Checkbox
            label={
              <>
                Bill this to the client <span className="muted">· {project!.client_name}</span>
              </>
            }
            hint="Once approved it goes on their next draft invoice."
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
          />
        ) : null}
        <TextArea label="What was it for?" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <label className={file ? s.dropFilled : s.drop}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
          </svg>
          <span className={s.dropTitle}>{file ? file.name : 'Add a receipt'}</span>
          <span className={s.dropHint}>
            {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · choose another to replace it` : 'Photo or PDF, up to 10 MB · only you, your manager and payroll admins can open it'}
          </span>
          <input
            key={inputKey}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
            className="visually-hidden"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </label>
        {fileError ? <p className={s.fileError}>{fileError}</p> : null}
        <ActionError error={action.error} />
        <Button type="submit" variant="primary" disabled={!ready || action.busy}>
          {action.busy ? 'Submitting…' : 'Submit for approval'}
        </Button>
      </form>
    </Card>
  );
}

function Claims({ items, onChange }: { items: ExpenseDTO[]; onChange: (e: ExpenseDTO) => void }) {
  const action = useAction();
  if (!items.length)
    return (
      <Empty title="No claims in this range">
        Add one with the form. It goes to your team manager, or an org admin if you don&apos;t have one.
      </Empty>
    );
  return (
    <>
      <ActionError error={action.error} />
      <TableBox label="Your claims">
        <table className={tableClass}>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Claim</th>
              <th scope="col" className={numClass}>
                Amount
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => {
              const st = claimStatus(e);
              return (
                <tr key={e.id} className={e.status === 'cancelled' ? s.withdrawn : undefined}>
                  <td className="mono small">{formatDayMonth(e.spent_on)}</td>
                  <td>
                    <span className={s.what}>{e.note}</span>
                    <span className={s.meta}>
                      {claimMeta(e)}
                      {e.has_receipt ? null : ' · no receipt'}
                    </span>
                  </td>
                  <td className={numClass}>{formatMoney(e.amount_cents, e.currency)}</td>
                  <td>
                    <span className={s.status}>
                      <Badge tone={st.tone === 'strong' ? 'outline' : st.tone} className={st.tone === 'strong' ? s.strong : undefined}>
                        {st.label}
                      </Badge>
                      {st.note ? <span className={s.meta}>{st.note}</span> : null}
                      {e.status === 'pending' ? (
                        <Button
                          size="sm"
                          variant="link"
                          disabled={action.busy}
                          onClick={async () => {
                            const r = await action.run(() => rd.expenses.cancel(e.id));
                            if (r) onChange(r);
                          }}
                        >
                          Withdraw
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableBox>
    </>
  );
}

export default function ExpensesPage() {
  const { access, timezone: tz } = useMe();
  const [today] = useState(() => todayInTz(tz));
  const [range, setRange] = useState<ClaimRange>('quarter');
  const from = claimsFrom(range, today);
  const mine = useApi(can(access, 'expenses') ? `me:expenses|${from}` : null, (signal) => rd.expenses.mine(from, signal));
  const rate = useApi(can(access, 'expenses') ? 'expenses:pay-rate' : null, (signal) => rd.money.myPayRate(signal).catch(() => null));

  if (!can(access, 'expenses')) return <NoAccess what="Expense claims are part of the Pro plan. Ask an org admin about upgrading." />;

  const data = mine.data;
  // New claims start in the currency you last claimed in, else the one you're paid in.
  const currency = data?.items[0]?.currency ?? rate.data?.current?.currency ?? 'USD';
  const refresh = () => mine.reload();

  return (
    <>
      <PageHeader
        eyebrow="Employee · Expenses"
        title="Expenses"
        description="Claim what you spent for work. Your team manager approves it, it's paid with the next payroll, and client costs can go on the client's invoice."
      />
      {mine.error ? (
        <ErrorState error={mine.error} onRetry={refresh} />
      ) : !data || rate.loading ? (
        <Loading label="Loading your expenses" />
      ) : (
        <>
          <section aria-label="Totals" className={s.tiles}>
            <div className={s.tile}>
              <span className={s.tileLabel}>Waiting for approval</span>
              <span className={s.tileValue}>{totalText(data.totals.waiting, currency)}</span>
              <span className={s.tileSub}>{totalCount(data.totals.waiting)}</span>
            </div>
            <div className={s.tile}>
              <span className={s.tileLabel}>To be paid</span>
              <span className={s.tileValue}>{totalText(data.totals.to_be_paid, currency)}</span>
              <span className={s.tileSub}>{data.totals.to_be_paid.length ? 'With the next payroll' : 'Nothing approved and unpaid'}</span>
            </div>
            <div className={s.tile}>
              <span className={s.tileLabel}>Paid this year</span>
              <span className={s.tileValue}>{totalText(data.totals.paid_this_year, currency)}</span>
              <span className={s.tileSub}>{totalCount(data.totals.paid_this_year)}</span>
            </div>
          </section>
          <div className={s.layout}>
            <NewClaim key={currency} today={today} currency={currency} onCreated={refresh} />
            <Card
              title="Your claims"
              className={s.list}
              actions={
                <InlineSelect label="Show" value={range} onChange={(e) => setRange(e.target.value as ClaimRange)}>
                  <option value="quarter">Last 3 months</option>
                  <option value="year">This year</option>
                </InlineSelect>
              }
            >
              <Claims items={data.items} onChange={refresh} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
