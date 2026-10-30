'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { invoiceTotals, lineAmountCents, type InvoiceDTO, type InvoiceLineInput } from '@rd/contracts';
import { Button, ButtonLink, buttonClass } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatDuration, formatMoney, formatNumber } from '@/lib/format';
import { useMe } from '@/lib/me';
import { centsToInput, decimalToInput, formatPercentBp, invoiceStateLabel, parseHoursInput, parseMoneyInput, parsePercentBp } from '@/lib/money';
import { formatDateTime, formatDayLabel, todayInTz } from '@/lib/time';
import { invoiceState } from '@/lib/workspaces';
import { useAction, useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import { MoneyGate } from '../../MoneyGate';
import m from '../../money.module.css';

interface DraftLine {
  key: string;
  project_id: string | null;
  user_id: string | null;
  description: string;
  hours: string;
  rate: string;
  /** Kept so a line billing an expense (F7) stays linked to it. */
  expense_id?: string | null;
}

const toDraft = (inv: InvoiceDTO): DraftLine[] =>
  inv.lines.map((l) => ({
    key: l.id,
    project_id: l.project_id,
    user_id: l.user_id,
    description: l.description,
    hours: decimalToInput(l.hours, 2),
    rate: centsToInput(l.rate_cents),
    expense_id: l.expense_id,
  }));

function Totals({ subtotal, taxBp, currency }: { subtotal: number; taxBp: number; currency: string }) {
  const sums = invoiceTotals([subtotal], taxBp);
  return (
    <dl className={m.totals}>
      <dt>{t('money.inv.subtotal')}</dt>
      <dd>{formatMoney(sums.subtotal_cents, currency)}</dd>
      <dt>{t('money.inv.tax', { rate: formatPercentBp(taxBp) })}</dt>
      <dd>{formatMoney(sums.tax_cents, currency)}</dd>
      <dt className={m.totalRow}>{t('money.inv.total')}</dt>
      <dd className={m.totalRow}>{formatMoney(sums.total_cents, currency)}</dd>
    </dl>
  );
}

function LinesEditor({ inv, onSaved }: { inv: InvoiceDTO; onSaved: (i: InvoiceDTO) => void }) {
  const [lines, setLines] = useState<DraftLine[]>(() => toDraft(inv));
  const [dirty, setDirty] = useState(false);
  const save = useAction();
  const parsed = lines.map((l) => ({ hours: parseHoursInput(l.hours), rate: parseMoneyInput(l.rate) }));
  const valid = lines.every((l, i) => l.description.trim() && parsed[i]!.hours !== null && parsed[i]!.rate !== null);
  const subtotal = parsed.reduce((n, p) => n + (p.hours !== null && p.rate !== null ? lineAmountCents(p.hours, p.rate) : 0), 0);

  const edit = (i: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const body: InvoiceLineInput[] = lines.map((l, i) => ({
      project_id: l.project_id,
      user_id: l.user_id,
      description: l.description.trim(),
      hours: parsed[i]!.hours!,
      rate_cents: parsed[i]!.rate!,
      expense_id: l.expense_id ?? null,
    }));
    const r = await save.run(() => rd.money.setInvoiceLines(inv.id, body));
    if (r) {
      setDirty(false);
      onSaved(r);
    }
  };

  return (
    <form onSubmit={submit} className={m.stack}>
      <TableBox label={t('money.inv.lineTable')}>
        <table className={tableClass} style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th scope="col">{t('money.inv.description2')}</th>
              <th scope="col" className={numClass}>
                {t('money.inv.hours')}
              </th>
              <th scope="col" className={numClass}>
                {t('money.inv.rateIn', { currency: inv.currency })}
              </th>
              <th scope="col" className={numClass}>
                {t('money.inv.amount')}
              </th>
              <th scope="col">
                <span className="visually-hidden">{t('money.inv.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const p = parsed[i]!;
              return (
                <tr key={l.key}>
                  <td>
                    <input
                      className={m.cellInput}
                      aria-label={t('money.inv.lineDescription', { n: i + 1 })}
                      value={l.description}
                      maxLength={500}
                      onChange={(e) => edit(i, { description: e.target.value })}
                    />
                  </td>
                  <td style={{ width: 110 }}>
                    <input
                      className={`${m.cellInput} ${m.cellNum}`}
                      aria-label={t('money.inv.lineHours', { n: i + 1 })}
                      inputMode="decimal"
                      value={l.hours}
                      aria-invalid={p.hours === null || undefined}
                      onChange={(e) => edit(i, { hours: e.target.value })}
                    />
                  </td>
                  <td style={{ width: 130 }}>
                    <input
                      className={`${m.cellInput} ${m.cellNum}`}
                      aria-label={t('money.inv.lineRate', { n: i + 1 })}
                      inputMode="decimal"
                      value={l.rate}
                      aria-invalid={p.rate === null || undefined}
                      onChange={(e) => edit(i, { rate: e.target.value })}
                    />
                  </td>
                  <td className={numClass}>{p.hours !== null && p.rate !== null ? formatMoney(lineAmountCents(p.hours, p.rate), inv.currency) : '—'}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="quiet"
                      aria-label={t('money.inv.removeLine', { n: i + 1 })}
                      onClick={() => {
                        setLines((prev) => prev.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      {t('money.inv.remove')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableBox>
      <div>
        <Button
          size="sm"
          onClick={() => {
            setLines((prev) => [...prev, { key: `new-${Date.now()}`, project_id: null, user_id: null, description: '', hours: decimalToInput(1, 2), rate: centsToInput(0) }]);
            setDirty(true);
          }}
        >
          {t('money.inv.addLine')}
        </Button>
      </div>
      <Totals subtotal={subtotal} taxBp={inv.tax_rate_bp} currency={inv.currency} />
      <ActionError error={save.error} />
      <div className={formActionsClass}>
        {dirty ? <span className="small muted">{t('money.inv.unsaved')}</span> : null}
        <Button type="submit" variant="primary" disabled={!dirty || !valid || save.busy}>
          {t('money.inv.saveLines')}
        </Button>
      </div>
    </form>
  );
}

function DraftDetails({ inv, onSaved }: { inv: InvoiceDTO; onSaved: (i: InvoiceDTO) => void }) {
  const [tax, setTax] = useState(decimalToInput(inv.tax_rate_bp / 100, inv.tax_rate_bp % 100 === 0 ? 0 : 2));
  const [due, setDue] = useState(inv.due_date ?? '');
  const [notes, setNotes] = useState(inv.notes ?? '');
  const save = useAction();
  const taxBp = parsePercentBp(tax);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (taxBp === null) return;
    const r = await save.run(() => rd.money.updateInvoice(inv.id, { tax_rate_bp: taxBp, due_date: due || null, notes: notes.trim() || null }));
    if (r) onSaved(r);
  };
  return (
    <Card title={t('money.inv.terms')}>
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <TextField
            label={t('money.inv.taxRate')}
            inputMode="decimal"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            error={taxBp === null ? t('money.inv.taxInvalid') : null}
          />
          <TextField label={t('money.inv.dueOptional')} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <TextArea label={t('money.inv.notesOptional')} rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <ActionError error={save.error} />
        <div className={formActionsClass}>
          <Button type="submit" disabled={taxBp === null || save.busy}>
            {t('money.inv.saveTerms')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function InvoiceContent({ id }: { id: string }) {
  const router = useRouter();
  const { timezone: tz } = useMe();
  const res = useApi(`money:invoice|${id}`, (signal) => rd.money.invoice(id, signal));
  const action = useAction();
  const [dialog, setDialog] = useState<'issue' | 'void' | 'delete' | 'paid' | 'send' | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const today = todayInTz(tz);
  const [paidOn, setPaidOn] = useState(today);
  const [payNote, setPayNote] = useState('');
  const [sendTo, setSendTo] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label={t('money.inv.loadingOne')} />;
  const inv = res.data;
  const replace = (next: InvoiceDTO) => res.mutate(() => next);
  const close = () => {
    setDialog(null);
    action.reset();
  };

  const issue = async () => {
    const r = await action.run(() => rd.money.issueInvoice(inv.id, dueDate || inv.due_date || null));
    if (r) {
      replace(r);
      setDialog(null);
    }
  };
  const voidIt = async () => {
    const r = await action.run(() => rd.money.voidInvoice(inv.id, reason.trim() || undefined));
    if (r) {
      replace(r);
      setDialog(null);
    }
  };
  const markPaid = async () => {
    const r = await action.run(() => rd.money.markInvoicePaid(inv.id, paidOn, payNote.trim() || undefined));
    if (r) {
      replace(r);
      setDialog(null);
    }
  };
  const markUnpaid = async () => {
    const r = await action.run(() => rd.money.markInvoiceUnpaid(inv.id));
    if (r) replace(r);
  };
  const send = async () => {
    const to = sendTo.trim() || undefined;
    const r = await action.run(() => rd.money.sendInvoice(inv.id, { to, message: message.trim() || undefined }));
    if (r) {
      replace(r);
      setDialog(null);
      setNotice(t('money.inv.sentTo', { email: r.sent_to ?? '' }));
    }
  };
  const state = invoiceState(inv, today);
  const remove = async () => {
    if (await action.run(() => rd.money.deleteInvoice(inv.id))) router.push('/admin/invoices');
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/admin/invoices">{t('money.inv.title')}</Link> · {invoiceStateLabel(state)}
          </>
        }
        title={inv.number ?? t('money.inv.draftTitle')}
        description={t('money.inv.headDescription', {
          client: inv.client.name,
          from: formatDayLabel(inv.period_from),
          to: formatDayLabel(inv.period_to),
          tz: inv.timezone,
        })}
        actions={
          <>
            <a className={buttonClass('secondary')} href={rd.money.invoiceCsvUrl(inv.id)} download>
              {t('money.inv.downloadCsv')}
            </a>
            <ButtonLink href={`/print/invoices/${inv.id}`} target="_blank" rel="noopener">
              {t('money.inv.printable')}
            </ButtonLink>
            {inv.status === 'draft' ? (
              <>
                <Button variant="quiet" onClick={() => setDialog('delete')}>
                  {t('money.inv.deleteDraft')}
                </Button>
                <Button variant="primary" onClick={() => setDialog('issue')} disabled={inv.lines.length === 0}>
                  {t('money.inv.issue')}
                </Button>
              </>
            ) : null}
            {inv.status === 'issued' ? (
              <>
                <Button onClick={() => setDialog('void')}>{t('money.inv.void')}</Button>
                <Button onClick={() => setDialog('send')}>{inv.sent_at ? t('money.inv.sendAgain') : t('money.inv.send')}</Button>
                {inv.paid_on ? null : (
                  <Button variant="primary" onClick={() => setDialog('paid')}>
                    {t('money.inv.markPaid')}
                  </Button>
                )}
              </>
            ) : null}
          </>
        }
      />
      {inv.status === 'draft' && inv.unrated_seconds > 0 ? (
        <Banner tone="warn" title={t('money.inv.noRateTitle')}>
          {t('money.inv.noRateBody', { duration: formatDuration(inv.unrated_seconds), currency: inv.currency })}{' '}
          <Link href="/admin/rates">{t('money.inv.ratesLink')}</Link> {t('money.inv.noRateTail')}
        </Banner>
      ) : null}
      {notice ? <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>{t('common.dismiss')}</Button>} /> : null}
      {state === 'overdue' ? (
        <Banner tone="warn" title={t('money.inv.overdueTitle')}>
          {t('money.inv.overdueBody', { date: formatDayLabel(inv.due_date!) })}
          {inv.sent_at ? t('money.inv.lastSent', { when: formatDateTime(inv.sent_at, tz), email: inv.sent_to ?? '' }) : t('money.inv.notSent')}
        </Banner>
      ) : null}
      {inv.status === 'void' ? (
        <Banner title={t('money.inv.voidTitle')}>
          {t('money.inv.voided', { when: formatDateTime(inv.voided_at, tz) })}
          {inv.void_reason ? ` — ${inv.void_reason}` : ''}
          {t('money.inv.voidTail')}
        </Banner>
      ) : null}
      {inv.status === 'draft' ? (
        <Banner tag="NOTE">
          {/* TODO(timesheets): switch this wording to "approved time" once timesheets land. */}
          {t('money.inv.builtFrom', { client: inv.client.name })}
        </Banner>
      ) : null}

      <Card title={t('money.inv.linesCard')} subtitle={inv.group_by === 'project_person' ? t('money.inv.perProjectPersonSub') : t('money.inv.perProjectSub')}>
        {inv.status === 'draft' ? (
          <LinesEditor key={inv.id + inv.subtotal_cents} inv={inv} onSaved={replace} />
        ) : (
          <>
            <TableBox label={t('money.inv.lineTable')}>
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('money.inv.description2')}</th>
                    <th scope="col" className={numClass}>
                      {t('money.inv.hours')}
                    </th>
                    <th scope="col" className={numClass}>
                      {t('money.inv.rate')}
                    </th>
                    <th scope="col" className={numClass}>
                      {t('money.inv.amount')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.description}</td>
                      <td className={numClass}>{formatNumber(l.hours, 2)}</td>
                      <td className={numClass}>{formatMoney(l.rate_cents, inv.currency)}</td>
                      <td className={numClass}>{formatMoney(l.amount_cents, inv.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
            <Totals subtotal={inv.subtotal_cents} taxBp={inv.tax_rate_bp} currency={inv.currency} />
          </>
        )}
      </Card>

      {inv.status === 'draft' ? (
        <DraftDetails key={`${inv.id}|${inv.tax_rate_bp}`} inv={inv} onSaved={replace} />
      ) : (
        <Card title={t('money.inv.terms')}>
          <div className={m.row}>
            <span>
              {t('money.inv.issued')} <strong>{formatDateTime(inv.issued_at, tz)}</strong>
            </span>
            <span>{t('money.inv.due', { date: inv.due_date ? formatDayLabel(inv.due_date) : '—' })}</span>
            <Badge tone={state === 'overdue' ? 'warn' : state === 'paid' ? 'solid' : 'outline'}>{invoiceStateLabel(state)}</Badge>
          </div>
          {inv.sent_at ? (
            <p className="small secondary">{t('money.inv.sentLine', { when: formatDateTime(inv.sent_at, tz), email: inv.sent_to ?? '' })}</p>
          ) : null}
          {inv.paid_on ? (
            <div className={m.row}>
              <span>
                {t('money.inv.paid')} <strong>{formatDayLabel(inv.paid_on)}</strong>
                {inv.payment_note ? ` · ${inv.payment_note}` : ''}
              </span>
              <Button size="sm" variant="quiet" onClick={markUnpaid} disabled={action.busy}>
                {t('money.inv.undoPaid')}
              </Button>
            </div>
          ) : null}
          {inv.notes ? <p className="secondary">{inv.notes}</p> : null}
        </Card>
      )}

      <Dialog
        open={dialog === 'issue'}
        onClose={close}
        title={t('money.inv.issueTitle')}
        description={t('money.inv.issueBody')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={issue} disabled={action.busy}>
              {t('money.inv.issue')}
            </Button>
          </>
        }
      >
        <TextField label={t('money.inv.dueDate')} type="date" value={dueDate || inv.due_date || ''} onChange={(e) => setDueDate(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'void'}
        onClose={close}
        title={t('money.inv.voidQ', { number: inv.number ?? '' })}
        description={t('money.inv.voidBody')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={voidIt} disabled={action.busy}>
              {t('money.inv.void')}
            </Button>
          </>
        }
      >
        <TextField label={t('money.inv.reasonOptional')} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'paid'}
        onClose={close}
        title={t('money.inv.paidQ', { number: inv.number ?? '' })}
        description={t('money.inv.paidBody')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={markPaid} disabled={action.busy || !paidOn}>
              {t('money.inv.markPaid')}
            </Button>
          </>
        }
      >
        <TextField label={t('money.inv.paidOn')} type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required />
        <TextField
          label={t('money.inv.noteOptional')}
          hint={t('money.inv.noteHint')}
          value={payNote}
          maxLength={500}
          onChange={(e) => setPayNote(e.target.value)}
        />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'send'}
        onClose={close}
        title={t('money.inv.emailQ', { number: inv.number ?? '', client: inv.client.name })}
        description={t('money.inv.emailBody')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={send} disabled={action.busy || (!inv.client.contact_email && !sendTo.trim())}>
              {action.busy ? t('money.inv.sending') : t('money.inv.sendInvoice')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('money.inv.to')}
          type="email"
          placeholder={inv.client.contact_email ?? 'billing@client.com'}
          hint={inv.client.contact_email ? t('money.inv.leaveEmpty', { email: inv.client.contact_email }) : t('money.inv.noBillingEmail')}
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
        />
        <TextArea label={t('money.inv.messageOptional')} rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'delete'}
        onClose={close}
        title={t('money.inv.deleteQ')}
        description={t('money.inv.deleteBody')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={remove} disabled={action.busy}>
              {t('money.inv.deleteDraft')}
            </Button>
          </>
        }
      >
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}

export default function InvoicePage() {
  const params = useParams<{ id: string }>();
  return (
    <MoneyGate title={t('money.inv.title')}>
      <InvoiceContent id={decodeURIComponent(params.id ?? '')} />
    </MoneyGate>
  );
}
