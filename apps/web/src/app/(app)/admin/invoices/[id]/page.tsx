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
import { centsToInput, decimalToInput, formatPercentBp, parseHoursInput, parseMoneyInput, parsePercentBp } from '@/lib/money';
import { formatDateTime, formatDayLabel, todayInTz } from '@/lib/time';
import { INVOICE_STATE_LABEL, invoiceState } from '@/lib/workspaces';
import { useAction, useApi } from '@/lib/useApi';
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
  const t = invoiceTotals([subtotal], taxBp);
  return (
    <dl className={m.totals}>
      <dt>Subtotal</dt>
      <dd>{formatMoney(t.subtotal_cents, currency)}</dd>
      <dt>Tax ({formatPercentBp(taxBp)})</dt>
      <dd>{formatMoney(t.tax_cents, currency)}</dd>
      <dt className={m.totalRow}>Total</dt>
      <dd className={m.totalRow}>{formatMoney(t.total_cents, currency)}</dd>
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
      <TableBox label="Invoice lines">
        <table className={tableClass} style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className={numClass}>
                Hours
              </th>
              <th scope="col" className={numClass}>
                Rate ({inv.currency}/h)
              </th>
              <th scope="col" className={numClass}>
                Amount
              </th>
              <th scope="col">
                <span className="visually-hidden">Remove</span>
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
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      maxLength={500}
                      onChange={(e) => edit(i, { description: e.target.value })}
                    />
                  </td>
                  <td style={{ width: 110 }}>
                    <input
                      className={`${m.cellInput} ${m.cellNum}`}
                      aria-label={`Line ${i + 1} hours`}
                      inputMode="decimal"
                      value={l.hours}
                      aria-invalid={p.hours === null || undefined}
                      onChange={(e) => edit(i, { hours: e.target.value })}
                    />
                  </td>
                  <td style={{ width: 130 }}>
                    <input
                      className={`${m.cellInput} ${m.cellNum}`}
                      aria-label={`Line ${i + 1} rate`}
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
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => {
                        setLines((prev) => prev.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      Remove
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
            setLines((prev) => [...prev, { key: `new-${Date.now()}`, project_id: null, user_id: null, description: '', hours: '1.00', rate: '0.00' }]);
            setDirty(true);
          }}
        >
          + Add line
        </Button>
      </div>
      <Totals subtotal={subtotal} taxBp={inv.tax_rate_bp} currency={inv.currency} />
      <ActionError error={save.error} />
      <div className={formActionsClass}>
        {dirty ? <span className="small muted">Unsaved changes</span> : null}
        <Button type="submit" variant="primary" disabled={!dirty || !valid || save.busy}>
          Save lines
        </Button>
      </div>
    </form>
  );
}

function DraftDetails({ inv, onSaved }: { inv: InvoiceDTO; onSaved: (i: InvoiceDTO) => void }) {
  const [tax, setTax] = useState((inv.tax_rate_bp / 100).toString());
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
    <Card title="Terms">
      <form onSubmit={submit} className={m.stack}>
        <div className={formGridClass}>
          <TextField
            label="Tax rate (%)"
            inputMode="decimal"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            error={taxBp === null ? 'Enter a percentage between 0 and 100' : null}
          />
          <TextField label="Due date (optional)" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <TextArea label="Notes on the invoice (optional)" rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <ActionError error={save.error} />
        <div className={formActionsClass}>
          <Button type="submit" disabled={taxBp === null || save.busy}>
            Save terms
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
  if (!res.data) return <Loading label="Loading the invoice" />;
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
      setNotice(`Sent to ${r.sent_to}`);
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
            <Link href="/admin/invoices">Invoices</Link> · {INVOICE_STATE_LABEL[state]}
          </>
        }
        title={inv.number ?? 'Draft invoice'}
        description={`${inv.client.name} · ${formatDayLabel(inv.period_from)} – ${formatDayLabel(inv.period_to)} (${inv.timezone})`}
        actions={
          <>
            <a className={buttonClass('secondary')} href={rd.money.invoiceCsvUrl(inv.id)} download>
              Download CSV
            </a>
            <ButtonLink href={`/print/invoices/${inv.id}`} target="_blank" rel="noopener">
              Printable invoice
            </ButtonLink>
            {inv.status === 'draft' ? (
              <>
                <Button variant="quiet" onClick={() => setDialog('delete')}>
                  Delete draft
                </Button>
                <Button variant="primary" onClick={() => setDialog('issue')} disabled={inv.lines.length === 0}>
                  Issue invoice
                </Button>
              </>
            ) : null}
            {inv.status === 'issued' ? (
              <>
                <Button onClick={() => setDialog('void')}>Void invoice</Button>
                <Button onClick={() => setDialog('send')}>{inv.sent_at ? 'Send again…' : 'Send to client…'}</Button>
                {inv.paid_on ? null : (
                  <Button variant="primary" onClick={() => setDialog('paid')}>
                    Mark paid
                  </Button>
                )}
              </>
            ) : null}
          </>
        }
      />
      {inv.status === 'draft' && inv.unrated_seconds > 0 ? (
        <Banner tone="warn" title="Some time has no bill rate">
          {formatDuration(inv.unrated_seconds)} on this client&apos;s projects in this period has no bill rate in {inv.currency}, so it isn&apos;t on this
          draft. Add a bill rate in <Link href="/admin/rates">Rates and budgets</Link> and build a new draft, or add a line by hand.
        </Banner>
      ) : null}
      {notice ? <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>Dismiss</Button>} /> : null}
      {state === 'overdue' ? (
        <Banner tone="warn" title="Overdue">
          It was due {formatDayLabel(inv.due_date!)} and isn&apos;t marked paid.
          {inv.sent_at ? ` Last sent ${formatDateTime(inv.sent_at, tz)} to ${inv.sent_to}.` : ' It hasn’t been sent from Track.'}
        </Banner>
      ) : null}
      {inv.status === 'void' ? (
        <Banner title="This invoice is void">
          Voided {formatDateTime(inv.voided_at, tz)}
          {inv.void_reason ? ` — ${inv.void_reason}` : ''}. Its number is not reused.
        </Banner>
      ) : null}
      {inv.status === 'draft' ? (
        <Banner tag="NOTE">
          {/* TODO(timesheets): switch this wording to "approved time" once timesheets land. */}
          Built from all recorded time on {inv.client.name}&apos;s projects (agent-tracked and approved manual time). Issuing locks the invoice.
        </Banner>
      ) : null}

      <Card title="Lines" subtitle={inv.group_by === 'project_person' ? 'Per project and person' : 'Per project'}>
        {inv.status === 'draft' ? (
          <LinesEditor key={inv.id + inv.subtotal_cents} inv={inv} onSaved={replace} />
        ) : (
          <>
            <TableBox label="Invoice lines">
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col" className={numClass}>
                      Hours
                    </th>
                    <th scope="col" className={numClass}>
                      Rate
                    </th>
                    <th scope="col" className={numClass}>
                      Amount
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
        <Card title="Terms">
          <div className={m.row}>
            <span>
              Issued <strong>{formatDateTime(inv.issued_at, tz)}</strong>
            </span>
            <span>Due {inv.due_date ? formatDayLabel(inv.due_date) : '—'}</span>
            <Badge tone={state === 'overdue' ? 'warn' : state === 'paid' ? 'solid' : 'outline'}>{INVOICE_STATE_LABEL[state]}</Badge>
          </div>
          {inv.sent_at ? (
            <p className="small secondary">
              Sent {formatDateTime(inv.sent_at, tz)} to {inv.sent_to}
            </p>
          ) : null}
          {inv.paid_on ? (
            <div className={m.row}>
              <span>
                Paid <strong>{formatDayLabel(inv.paid_on)}</strong>
                {inv.payment_note ? ` · ${inv.payment_note}` : ''}
              </span>
              <Button size="sm" variant="quiet" onClick={markUnpaid} disabled={action.busy}>
                Undo payment
              </Button>
            </div>
          ) : null}
          {inv.notes ? <p className="secondary">{inv.notes}</p> : null}
        </Card>
      )}

      <Dialog
        open={dialog === 'issue'}
        onClose={close}
        title="Issue this invoice?"
        description="It gets the next invoice number and is locked: lines, tax and terms can no longer change. To correct an issued invoice, void it and build a new one."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={issue} disabled={action.busy}>
              Issue invoice
            </Button>
          </>
        }
      >
        <TextField label="Due date" type="date" value={dueDate || inv.due_date || ''} onChange={(e) => setDueDate(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'void'}
        onClose={close}
        title={`Void ${inv.number}?`}
        description="The invoice stays on record as void and its number is not reused."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" onClick={voidIt} disabled={action.busy}>
              Void invoice
            </Button>
          </>
        }
      >
        <TextField label="Reason (optional)" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'paid'}
        onClose={close}
        title={`Mark ${inv.number} paid?`}
        description="Records when the money arrived. What was billed doesn't change, and you can undo it."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={markPaid} disabled={action.busy || !paidOn}>
              Mark paid
            </Button>
          </>
        }
      >
        <TextField label="Paid on" type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required />
        <TextField label="Note (optional)" hint="A payment reference, for example" value={payNote} maxLength={500} onChange={(e) => setPayNote(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'send'}
        onClose={close}
        title={`Email ${inv.number} to ${inv.client.name}?`}
        description="The email carries the invoice itself: lines, totals and due date. Replies come to you."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={send} disabled={action.busy || (!inv.client.contact_email && !sendTo.trim())}>
              {action.busy ? 'Sending…' : 'Send invoice'}
            </Button>
          </>
        }
      >
        <TextField
          label="To"
          type="email"
          placeholder={inv.client.contact_email ?? 'billing@client.com'}
          hint={inv.client.contact_email ? `Leave empty to send to ${inv.client.contact_email}` : 'This client has no billing email yet'}
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
        />
        <TextArea label="Message (optional)" rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
      <Dialog
        open={dialog === 'delete'}
        onClose={close}
        title="Delete this draft?"
        description="Drafts have no number yet, so nothing is skipped."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" onClick={remove} disabled={action.busy}>
              Delete draft
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
    <MoneyGate title="Invoices">
      <InvoiceContent id={decodeURIComponent(params.id ?? '')} />
    </MoneyGate>
  );
}
