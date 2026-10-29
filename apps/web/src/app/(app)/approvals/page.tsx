'use client';

import { useState, type KeyboardEvent } from 'react';
import { EXPENSE_CATEGORY_LABELS, type CorrectionDTO, type CorrectionValues, type DeletionRequestDTO, type ExpenseDTO } from '@rd/contracts';
import { TimeOffReviewCard } from '@/components/scheduling/TimeOffApprovals';
import { TimesheetReviewCard } from '@/components/timesheet/TimesheetApprovals';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, formActionsClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { INBOX_TABS, batchSummary, inTab, inboxItems, itemKey, type InboxItem, type InboxTab } from '@/lib/approvals';
import { announceApprovalsChanged } from '@/lib/events';
import { formatDuration, formatMoney, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { can } from '@/lib/nav';
import { sched } from '@/lib/scheduling';
import { dateInTz, formatDateTime, formatDayLabel, formatRelative, formatShortDay, formatTime } from '@/lib/time';
import { timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../NoAccess';
import s from './approvals.module.css';

function Values({ v, tz, projectName, label }: { v: CorrectionValues | null; tz: string; projectName: (id: string | null) => string; label: string }) {
  if (!v)
    return (
      <div className={s.side}>
        <span className="label-mono">{label}</span>
        <p className="secondary">No original — this is new manual time.</p>
      </div>
    );
  const start = Date.parse(v.started_at);
  const end = Date.parse(v.ended_at);
  return (
    <div className={s.side}>
      <span className="label-mono">{label}</span>
      <dl className={dlClass}>
        <dt>Day</dt>
        <dd>{formatShortDay(dateInTz(start, tz))}</dd>
        <dt>Time</dt>
        <dd className="mono">
          {formatTime(start, tz)}–{formatTime(end, tz)}
        </dd>
        <dt>Duration</dt>
        <dd className="mono">{formatDuration((end - start) / 1000)}</dd>
        <dt>Project</dt>
        <dd>{projectName(v.project_id)}</dd>
      </dl>
    </div>
  );
}

function Review({ c, tz, projectName, onDone }: { c: CorrectionDTO; tz: string; projectName: (id: string | null) => string; onDone: (id: string) => void }) {
  const named = (id: string | null) => (id && c.project_names?.[id]) || projectName(id);
  const [note, setNote] = useState('');
  const action = useAction();
  const decide = async (approve: boolean) => {
    const r = await action.run(() => (approve ? rd.corrections.approve(c.id, note.trim() || undefined) : rd.corrections.reject(c.id, note.trim() || undefined)));
    if (r) onDone(c.id);
  };
  return (
    <Card
      title={`${c.user_name} · ${c.kind === 'manual_add' ? 'Manual time' : c.kind === 'idle_reassign' ? 'Idle time moved' : 'Correction'}`}
      subtitle={`Submitted ${formatDateTime(c.created_at, tz)}`}
    >
      <div className={s.compare}>
        <Values v={c.original} tz={tz} projectName={named} label="Original" />
        <Values v={c.requested} tz={tz} projectName={named} label="Requested" />
      </div>
      <p>
        <span className="label-mono">Reason</span>
        <br />“{c.reason}”
      </p>
      <TextArea label="Note to the employee (optional)" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy}>
          Reject
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          Approve
        </Button>
      </div>
    </Card>
  );
}

function DeletionReview({ d, tz, onDone }: { d: DeletionRequestDTO; tz: string; onDone: () => void }) {
  const action = useAction();
  const decide = async (approve: boolean) => {
    const r = await action.run(() => (approve ? rd.admin.approveDeletion(d.id) : rd.admin.rejectDeletion(d.id)));
    if (r) onDone();
  };
  return (
    <Card title={`${d.requester_name} · Deletion request`} subtitle={`Submitted ${formatDateTime(d.created_at, tz)}`}>
      <dl className={dlClass}>
        <dt>Screenshot</dt>
        <dd className="mono" title={d.target_id}>
          {d.target_id.slice(0, 8)}…
        </dd>
      </dl>
      <p>
        <span className="label-mono">Reason</span>
        <br />“{d.reason}”
      </p>
      <p className="small secondary">
        You decide without seeing the image. Approving deletes it permanently unless it is under a legal hold; the audit log keeps the screenshot id and
        the outcome. Rejecting keeps it until its retention date. {d.requester_name} is told either way.
      </p>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy}>
          Reject
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          Approve and delete
        </Button>
      </div>
    </Card>
  );
}

function ExpenseReview({ e, tz, onDone }: { e: ExpenseDTO; tz: string; onDone: () => void }) {
  const [note, setNote] = useState('');
  const action = useAction();
  const receipt = useAction();
  const decide = async (approve: boolean) => {
    const r = await action.run(() => (approve ? rd.expenses.approve(e.id, note.trim() || undefined) : rd.expenses.reject(e.id, note.trim())));
    if (r) onDone();
  };
  const openReceipt = async () => {
    // Open the tab first so the browser doesn't treat it as a pop-up, then point it at the short-lived link.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    const r = await receipt.run(() => rd.expenses.receiptUrl(e.id));
    if (r && tab) tab.location.href = r.url;
    else if (r) window.location.assign(r.url);
    else tab?.close();
  };
  return (
    <Card title={`${e.user_name} · Expense`} subtitle={`Submitted ${formatDateTime(e.created_at, tz)}`}>
      <dl className={dlClass}>
        <dt>Amount</dt>
        <dd className="mono">{formatMoney(e.amount_cents, e.currency)}</dd>
        <dt>Spent on</dt>
        <dd>{formatDayLabel(e.spent_on)}</dd>
        <dt>Category</dt>
        <dd>{EXPENSE_CATEGORY_LABELS[e.category]}</dd>
        <dt>Project</dt>
        <dd>{e.project_name ?? 'No project'}</dd>
        <dt>Client</dt>
        <dd>{e.billable && e.client_name ? `Billed to ${e.client_name}` : 'Not billed'}</dd>
      </dl>
      <p>
        <span className="label-mono">Note</span>
        <br />“{e.note}”
      </p>
      {e.has_receipt ? (
        <div>
          <Button size="sm" onClick={openReceipt} disabled={receipt.busy}>
            {receipt.busy ? 'Opening…' : 'Open the receipt'}
          </Button>
          <p className="small muted">Opening it is noted in {e.user_name}&apos;s access log.</p>
          <ActionError error={receipt.error} />
        </div>
      ) : (
        <Banner tone="warn" tag="NO RECEIPT" title="No receipt is attached">
          You can still approve it, or send it back asking for one.
        </Banner>
      )}
      <TextArea
        label="Note to the employee (required to send back)"
        rows={2}
        maxLength={1000}
        value={note}
        onChange={(ev) => setNote(ev.target.value)}
      />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy || note.trim().length < 3}>
          Send back
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          Approve
        </Button>
      </div>
      <p className="small muted">Approved, it&apos;s paid with the next payroll file{e.billable ? ' and goes on the client’s next draft invoice' : ''}.</p>
    </Card>
  );
}

export default function ApprovalsPage() {
  const { access, timezone: tz, me } = useMe();
  const timesheets = access.entitlements.includes('timesheets');
  const timeOffReview = access.entitlements.includes('time_off');
  // Org admins review corrections from people with no team manager, so they load them too.
  const corrections = useApi(access.managesTeams || access.isAdmin ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const sheets = useApi(timesheets ? 'timesheets:pending' : null, (signal) => timesheetsApi.pending(signal));
  const leave = useApi(timeOffReview ? 'timeoff:pending' : null, (signal) => sched.review.pending(signal));
  const deletions = useApi(access.isAdmin ? 'admin:deletion-requests' : null, (signal) => rd.admin.deletionRequests(signal));
  const expenseReview = access.entitlements.includes('expenses') && (access.managesTeams || access.isAdmin);
  const expenses = useApi(expenseReview ? 'expenses:pending' : null, (signal) => rd.expenses.pending(signal));
  const projects = useApi(access.managesTeams ? 'projects:managed' : null, (signal) => rd.projects.list(signal).catch(() => []));
  const [tab, setTab] = useState<InboxTab>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const batch = useAction();

  if (!can(access, 'approvals')) return <NoAccess what="Approvals are for team managers and org admins." />;

  const sources = [corrections, sheets, leave, deletions, expenses];
  const error = sources.find((x) => x.error)?.error;
  const loading = sources.some((x) => x.loading && !x.data);
  const items = inboxItems(corrections.data ?? [], sheets.data ?? [], leave.data ?? [], tz, deletions.data ?? [], expenses.data ?? []);
  // Deletion requests reach org admins only; expenses need the plan.
  const tabs = INBOX_TABS.filter((t) => (t.key !== 'privacy' || access.isAdmin) && (t.key !== 'expenses' || expenseReview));
  const visible = inTab(items, tab);
  const counts = Object.fromEntries(tabs.map((t) => [t.key, inTab(items, t.key).length])) as Record<InboxTab, number>;
  const chosen = items.filter((i) => selected.has(itemKey(i)));
  const chosenDeletions = chosen.filter((i) => i.type === 'deletion_request').length;
  const focused = visible.find((i) => itemKey(i) === focus) ?? visible[0] ?? null;
  const allVisibleChosen = visible.length > 0 && visible.every((i) => selected.has(itemKey(i)));
  const projectName = (id: string | null) => {
    if (!id) return 'No project';
    return projects.data?.find((p) => p.id === id)?.name ?? `Project ${id.slice(0, 8)}`;
  };

  /** Drop finished items from their lists and from the selection. */
  const remove = (done: readonly Pick<InboxItem, 'type' | 'id'>[]) => {
    const ids = (t: InboxItem['type']) => new Set(done.filter((d) => d.type === t).map((d) => d.id));
    const c = ids('correction');
    const t = ids('timesheet');
    const o = ids('time_off');
    const d = ids('deletion_request');
    const x = ids('expense');
    corrections.mutate((prev) => prev?.filter((x) => !c.has(x.id)));
    sheets.mutate((prev) => prev?.filter((x) => !x.id || !t.has(x.id)));
    leave.mutate((prev) => prev?.filter((x) => !o.has(x.id)));
    deletions.mutate((prev) => prev?.filter((x) => !d.has(x.id)));
    expenses.mutate((prev) => prev?.filter((e) => !x.has(e.id)));
    const keys = new Set(done.map(itemKey));
    setSelected((prev) => new Set([...prev].filter((k) => !keys.has(k))));
    if (done.length) announceApprovalsChanged();
  };
  const toggle = (i: InboxItem) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = itemKey(i);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of visible) {
        if (allVisibleChosen) next.delete(itemKey(i));
        else next.add(itemKey(i));
      }
      return next;
    });
  const run = async (action: 'approve' | 'reject', text?: string) => {
    setSummary(null);
    const r = await batch.run(() => rd.approvals.batch({ action, note: text, items: chosen.map(({ type, id }) => ({ type, id })) }));
    if (!r) return;
    setSummary(batchSummary(r));
    remove(r.results.filter((x) => x.ok));
    setSendingBack(false);
    setNote('');
  };
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || visible.length === 0) return;
    const at = Math.max(0, visible.findIndex((i) => itemKey(i) === (focused && itemKey(focused))));
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      setFocus(itemKey(visible[Math.min(visible.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)))]!));
    } else if (e.key === 'x' && focused) {
      e.preventDefault();
      toggle(focused);
    }
  };
  const onDone = (i: InboxItem) => () => remove([i]);

  return (
    <>
      <PageHeader
        eyebrow={`${access.managesTeams ? 'Team manager' : 'Org admin'} · Approvals`}
        title="Approvals"
        description={
          items.length
            ? `${plural(items.length, 'request')} waiting. Originals are kept whatever you decide; you never review your own.`
            : `Corrections, manual time, timesheets, time off${expenseReview ? ' and expense claims' : ''} from the people you review. Originals are kept whatever you decide.`
        }
      />
      {access.managesTeams && !me.entitlements.includes('correction_approvals') ? (
        <Banner tag="NOTE" title="Your plan doesn't include the approval workflow">
          Corrections apply straight away. An org admin can turn approvals on by moving to Standard or Pro.
        </Banner>
      ) : null}

      <div role="tablist" aria-label="Request type" className={s.tabs}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? s.tabOn : s.tab}
            onClick={() => setTab(t.key)}
          >
            {t.label} <span className="mono">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {summary ? (
        <Banner role="status" title={summary} actions={<Button variant="link" onClick={() => setSummary(null)}>Dismiss</Button>} />
      ) : null}
      {chosen.length > 0 ? (
        <section aria-label="Selected requests" className={s.selectionBar}>
          <strong>{chosen.length} selected</strong>
          <span className={s.selectionNote}>
            Each is checked on its own; anything that can&apos;t be done is listed after.
            {chosenDeletions ? ` Approving deletes ${plural(chosenDeletions, 'screenshot')} permanently.` : ''}
          </span>
          <span className={s.grow} />
          <Button size="sm" variant="quiet" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button size="sm" onClick={() => setSendingBack(true)} disabled={batch.busy}>
            Send back with a note…
          </Button>
          <Button size="sm" variant="primary" onClick={() => run('approve')} disabled={batch.busy}>
            {batch.busy ? 'Working…' : `Approve ${chosen.length}`}
          </Button>
        </section>
      ) : null}
      {!sendingBack ? <ActionError error={batch.error} /> : null}

      {error ? (
        <ErrorState error={error} onRetry={() => sources.forEach((x) => x.reload())} />
      ) : loading ? (
        <Loading label="Loading approvals" />
      ) : visible.length === 0 ? (
        <Card>
          <Empty title="Nothing to review">
            When someone submits a timesheet, adds or corrects time, asks for time off{expenseReview ? ', claims an expense' : ''}
            {access.isAdmin ? ' or asks to delete a screenshot' : ''}, it shows up here.
          </Empty>
        </Card>
      ) : (
        <div className={s.inbox}>
          <Card label="Requests" className={s.list}>
            <div onKeyDown={onKeys}>
              <TableBox label="Requests waiting for review">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col" className={s.check}>
                        <input type="checkbox" aria-label="Select all in this view" checked={allVisibleChosen} onChange={toggleAll} />
                      </th>
                      <th scope="col">Person · request</th>
                      <th scope="col">Type</th>
                      <th scope="col" className={numClass}>
                        Amount
                      </th>
                      <th scope="col">Waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => {
                      const k = itemKey(i);
                      const isFocus = focused !== null && itemKey(focused) === k;
                      return (
                        <tr key={k} className={isFocus ? s.rowFocus : undefined} aria-current={isFocus ? 'true' : undefined}>
                          <td className={s.check}>
                            <input type="checkbox" aria-label={`Select ${i.who}, ${i.what}`} checked={selected.has(k)} onChange={() => toggle(i)} />
                          </td>
                          <td>
                            <button type="button" className={s.rowButton} onClick={() => setFocus(k)}>
                              <span className={s.who}>{i.who}</span>
                              <span className={s.what}>{i.what}</span>
                            </button>
                            {i.flag ? <Badge tone="warn">{i.flag}</Badge> : null}
                          </td>
                          <td>
                            <Badge>{i.kindLabel}</Badge>
                          </td>
                          <td className={numClass}>{i.amount}</td>
                          <td className="small muted">{formatRelative(i.submittedAt, tz)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableBox>
              <p className="small muted">J / K to move · X to select</p>
            </div>
          </Card>
          <div className={s.detail} aria-live="polite">
            {focused?.type === 'correction' ? (
              <Review
                key={itemKey(focused)}
                c={corrections.data!.find((c) => c.id === focused.id)!}
                tz={tz}
                projectName={projectName}
                onDone={onDone(focused)}
              />
            ) : focused?.type === 'timesheet' ? (
              <TimesheetReviewCard key={itemKey(focused)} t={sheets.data!.find((t) => t.id === focused.id)!} tz={tz} onDone={onDone(focused)} />
            ) : focused?.type === 'time_off' ? (
              <TimeOffReviewCard key={itemKey(focused)} r={leave.data!.find((r) => r.id === focused.id)!} tz={tz} onDone={onDone(focused)} />
            ) : focused?.type === 'expense' ? (
              <ExpenseReview key={itemKey(focused)} e={expenses.data!.find((e) => e.id === focused.id)!} tz={tz} onDone={onDone(focused)} />
            ) : focused?.type === 'deletion_request' ? (
              <DeletionReview key={itemKey(focused)} d={deletions.data!.find((d) => d.id === focused.id)!} tz={tz} onDone={onDone(focused)} />
            ) : null}
          </div>
        </div>
      )}

      <Dialog
        open={sendingBack}
        onClose={() => {
          setSendingBack(false);
          batch.reset();
        }}
        size="sm"
        title={`Send back ${plural(chosen.length, 'request')}?`}
        description="The same note goes to each person. Their originals stay as they were."
        footer={
          <>
            <Button onClick={() => setSendingBack(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => run('reject', note.trim())} disabled={batch.busy || note.trim().length < 3}>
              {batch.busy ? 'Sending…' : 'Send back'}
            </Button>
          </>
        }
      >
        <TextArea label="Note (required)" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        <ActionError error={batch.error} />
      </Dialog>
    </>
  );
}
