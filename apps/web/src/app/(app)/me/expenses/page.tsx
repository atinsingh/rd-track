'use client';

import { useState, type FormEvent } from 'react';
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ExpenseDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { Checkbox, InlineSelect, SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { claimMeta, claimStatus, claimsFrom, expenseCategoryLabel, receiptProblem, totalCount, totalText, type ClaimRange } from '@/lib/expenses';
import { formatBytes, formatMoney } from '@/lib/format';
import { useMe } from '@/lib/me';
import { CURRENCIES, parseMoneyInput } from '@/lib/money';
import { can } from '@/lib/nav';
import { formatDayMonth, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
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
  const amountError = amount && (cents === null || cents < 1 || cents > 10_000_000) ? t('exp.amountError') : null;
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
        if (!put?.ok) throw new Error(t('exp.uploadFailed'));
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
    <Card title={t('exp.newClaim')} className={s.form}>
      <form onSubmit={submit} className={s.formBody}>
        <div className={s.pair}>
          <TextField label={t('exp.amount')} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} error={amountError} />
          <SelectField label={t('exp.currency')} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </SelectField>
        </div>
        <div className={s.pair}>
          <TextField label={t('exp.date')} type="date" max={today} value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          <SelectField label={t('exp.category')} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {expenseCategoryLabel(c)}
              </option>
            ))}
          </SelectField>
        </div>
        <SelectField label={t('exp.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t('exp.noProject')}</option>
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
                {t('exp.billToClient')} <span className="muted">· {project!.client_name}</span>
              </>
            }
            hint={t('exp.billHint')}
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
          />
        ) : null}
        <TextArea label={t('exp.whatFor')} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <label className={file ? s.dropFilled : s.drop}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
          </svg>
          <span className={s.dropTitle}>{file ? file.name : t('exp.addReceipt')}</span>
          <span className={s.dropHint}>
            {file ? t('exp.replaceFile', { size: formatBytes(file.size) }) : t('exp.receiptHint')}
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
          {action.busy ? t('ts.submitting') : t('ts.submit')}
        </Button>
      </form>
    </Card>
  );
}

function Claims({ items, onChange }: { items: ExpenseDTO[]; onChange: (e: ExpenseDTO) => void }) {
  const action = useAction();
  if (!items.length)
    return (
      <Empty title={t('exp.noClaims')}>
        {t('exp.noClaimsBody')}
      </Empty>
    );
  return (
    <>
      <ActionError error={action.error} />
      <TableBox label={t('exp.yourClaims')}>
        <table className={tableClass}>
          <thead>
            <tr>
              <th scope="col">{t('exp.col.date')}</th>
              <th scope="col">{t('exp.col.claim')}</th>
              <th scope="col" className={numClass}>
                {t('exp.col.amount')}
              </th>
              <th scope="col">{t('exp.col.status')}</th>
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
                      {e.has_receipt ? null : t('exp.noReceipt')}
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
                          {t('exp.withdraw')}
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

  if (!can(access, 'expenses')) return <NoAccess what={t('exp.noAccess')} />;

  const data = mine.data;
  // New claims start in the currency you last claimed in, else the one you're paid in.
  const currency = data?.items[0]?.currency ?? rate.data?.current?.currency ?? 'USD';
  const refresh = () => mine.reload();

  return (
    <>
      <PageHeader
        eyebrow={t('exp.eyebrow')}
        title={t('exp.title')}
        description={t('exp.description')}
      />
      {mine.error ? (
        <ErrorState error={mine.error} onRetry={refresh} />
      ) : !data || rate.loading ? (
        <Loading label={t('exp.loading')} />
      ) : (
        <>
          <section aria-label={t('exp.totals')} className={s.tiles}>
            <div className={s.tile}>
              <span className={s.tileLabel}>{t('exp.waitingTile')}</span>
              <span className={s.tileValue}>{totalText(data.totals.waiting, currency)}</span>
              <span className={s.tileSub}>{totalCount(data.totals.waiting)}</span>
            </div>
            <div className={s.tile}>
              <span className={s.tileLabel}>{t('exp.toBePaid')}</span>
              <span className={s.tileValue}>{totalText(data.totals.to_be_paid, currency)}</span>
              <span className={s.tileSub}>{data.totals.to_be_paid.length ? t('exp.withNext') : t('exp.nothingUnpaid')}</span>
            </div>
            <div className={s.tile}>
              <span className={s.tileLabel}>{t('exp.paidYear')}</span>
              <span className={s.tileValue}>{totalText(data.totals.paid_this_year, currency)}</span>
              <span className={s.tileSub}>{totalCount(data.totals.paid_this_year)}</span>
            </div>
          </section>
          <div className={s.layout}>
            <NewClaim key={currency} today={today} currency={currency} onCreated={refresh} />
            <Card
              title={t('exp.yourClaims')}
              className={s.list}
              actions={
                <InlineSelect label={t('exp.show')} value={range} onChange={(e) => setRange(e.target.value as ClaimRange)}>
                  <option value="quarter">{t('exp.last3')}</option>
                  <option value="year">{t('exp.thisYear')}</option>
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
