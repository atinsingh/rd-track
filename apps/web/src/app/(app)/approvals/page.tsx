'use client';

import { useState, type KeyboardEvent } from 'react';
import { type CorrectionDTO, type CorrectionValues, type DeletionRequestDTO, type ExpenseDTO } from '@rd/contracts';
import { TimeOffReviewCard } from '@/components/scheduling/TimeOffApprovals';
import { TimesheetReviewCard } from '@/components/timesheet/TimesheetApprovals';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, formActionsClass, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { INBOX_TABS, batchSummary, inTab, inboxItems, inboxTabLabel, itemKey, type InboxItem, type InboxTab } from '@/lib/approvals';
import { announceApprovalsChanged } from '@/lib/events';
import { expenseCategoryLabel } from '@/lib/expenses';
import { formatDuration, formatMoney } from '@/lib/format';
import { useMe } from '@/lib/me';
import { can } from '@/lib/nav';
import { sched } from '@/lib/scheduling';
import { dateInTz, formatDateTime, formatDayLabel, formatRelative, formatShortDay, formatTime } from '@/lib/time';
import { timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import { NoAccess } from '../NoAccess';
import s from './approvals.module.css';

function Values({ v, tz, projectName, label }: { v: CorrectionValues | null; tz: string; projectName: (id: string | null) => string; label: string }) {
  if (!v)
    return (
      <div className={s.side}>
        <span className="label-mono">{label}</span>
        <p className="secondary">{t('mgr.ap.noOriginal')}</p>
      </div>
    );
  const start = Date.parse(v.started_at);
  const end = Date.parse(v.ended_at);
  return (
    <div className={s.side}>
      <span className="label-mono">{label}</span>
      <dl className={dlClass}>
        <dt>{t('mgr.ap.day')}</dt>
        <dd>{formatShortDay(dateInTz(start, tz))}</dd>
        <dt>{t('mgr.ap.time')}</dt>
        <dd className="mono">
          {formatTime(start, tz)}–{formatTime(end, tz)}
        </dd>
        <dt>{t('mgr.ap.duration')}</dt>
        <dd className="mono">{formatDuration((end - start) / 1000)}</dd>
        <dt>{t('mgr.project')}</dt>
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
      title={`${c.user_name} · ${t(c.kind === 'manual_add' ? 'mgr.kindLabel.manual' : c.kind === 'idle_reassign' ? 'mgr.kindLabel.idle' : 'mgr.kindLabel.edit')}`}
      subtitle={t('mgr.ap.submitted', { when: formatDateTime(c.created_at, tz) })}
    >
      <div className={s.compare}>
        <Values v={c.original} tz={tz} projectName={named} label={t('mgr.ap.original')} />
        <Values v={c.requested} tz={tz} projectName={named} label={t('mgr.ap.requested')} />
      </div>
      <p>
        <span className="label-mono">{t('mgr.ap.reason')}</span>
        <br />“{c.reason}”
      </p>
      <TextArea label={t('mgr.ap.noteOptional')} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy}>
          {t('mgr.ap.reject')}
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          {t('mgr.ap.approve')}
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
    <Card title={t('mgr.ap.deletionTitle', { name: d.requester_name })} subtitle={t('mgr.ap.submitted', { when: formatDateTime(d.created_at, tz) })}>
      <dl className={dlClass}>
        <dt>{t('mgr.ap.screenshot')}</dt>
        <dd className="mono" title={d.target_id}>
          {d.target_id.slice(0, 8)}…
        </dd>
      </dl>
      <p>
        <span className="label-mono">{t('mgr.ap.reason')}</span>
        <br />“{d.reason}”
      </p>
      <p className="small secondary">
        {t('mgr.ap.deletionBody', { name: d.requester_name })}
      </p>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy}>
          {t('mgr.ap.reject')}
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          {t('mgr.ap.approveDelete')}
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
    <Card title={t('mgr.ap.expenseTitle', { name: e.user_name })} subtitle={t('mgr.ap.submitted', { when: formatDateTime(e.created_at, tz) })}>
      <dl className={dlClass}>
        <dt>{t('mgr.ap.amount')}</dt>
        <dd className="mono">{formatMoney(e.amount_cents, e.currency)}</dd>
        <dt>{t('mgr.ap.spentOn')}</dt>
        <dd>{formatDayLabel(e.spent_on)}</dd>
        <dt>{t('mgr.ap.category')}</dt>
        <dd>{expenseCategoryLabel(e.category)}</dd>
        <dt>{t('mgr.project')}</dt>
        <dd>{e.project_name ?? t('session.noProject')}</dd>
        <dt>{t('mgr.ap.client')}</dt>
        <dd>{e.billable && e.client_name ? t('mgr.ap.billedTo', { client: e.client_name }) : t('mgr.ap.notBilled')}</dd>
      </dl>
      <p>
        <span className="label-mono">{t('mgr.ap.note')}</span>
        <br />“{e.note}”
      </p>
      {e.has_receipt ? (
        <div>
          <Button size="sm" onClick={openReceipt} disabled={receipt.busy}>
            {receipt.busy ? t('mgr.ap.opening') : t('mgr.ap.openReceipt')}
          </Button>
          <p className="small muted">{t('mgr.ap.receiptLogged', { name: e.user_name })}</p>
          <ActionError error={receipt.error} />
        </div>
      ) : (
        <Banner tone="warn" tag={t('mgr.ap.noReceiptTag')} title={t('mgr.ap.noReceiptTitle')}>
          {t('mgr.ap.noReceiptBody')}
        </Banner>
      )}
      <TextArea
        label={t('mgr.ap.noteRequired')}
        rows={2}
        maxLength={1000}
        value={note}
        onChange={(ev) => setNote(ev.target.value)}
      />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy || note.trim().length < 3}>
          {t('mgr.ap.sendBack')}
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          {t('mgr.ap.approve')}
        </Button>
      </div>
      <p className="small muted">{t('mgr.ap.paidNext', { billed: e.billable ? t('mgr.ap.billedNext') : '' })}</p>
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

  if (!can(access, 'approvals')) return <NoAccess what={t('mgr.ap.noAccess')} />;

  const sources = [corrections, sheets, leave, deletions, expenses];
  const error = sources.find((x) => x.error)?.error;
  const loading = sources.some((x) => x.loading && !x.data);
  const items = inboxItems(corrections.data ?? [], sheets.data ?? [], leave.data ?? [], tz, deletions.data ?? [], expenses.data ?? []);
  // Deletion requests reach org admins only; expenses need the plan.
  const tabs = INBOX_TABS.filter((tb) => (tb.key !== 'privacy' || access.isAdmin) && (tb.key !== 'expenses' || expenseReview));
  const visible = inTab(items, tab);
  const counts = Object.fromEntries(tabs.map((tb) => [tb.key, inTab(items, tb.key).length])) as Record<InboxTab, number>;
  const chosen = items.filter((i) => selected.has(itemKey(i)));
  const chosenDeletions = chosen.filter((i) => i.type === 'deletion_request').length;
  const focused = visible.find((i) => itemKey(i) === focus) ?? visible[0] ?? null;
  const allVisibleChosen = visible.length > 0 && visible.every((i) => selected.has(itemKey(i)));
  const projectName = (id: string | null) => {
    if (!id) return t('session.noProject');
    return projects.data?.find((p) => p.id === id)?.name ?? t('mgr.ap.projectId', { id: id.slice(0, 8) });
  };

  /** Drop finished items from their lists and from the selection. */
  const remove = (done: readonly Pick<InboxItem, 'type' | 'id'>[]) => {
    const ids = (t: InboxItem['type']) => new Set(done.filter((d) => d.type === t).map((d) => d.id));
    const c = ids('correction');
    const ts = ids('timesheet');
    const o = ids('time_off');
    const d = ids('deletion_request');
    const x = ids('expense');
    corrections.mutate((prev) => prev?.filter((x) => !c.has(x.id)));
    sheets.mutate((prev) => prev?.filter((x) => !x.id || !ts.has(x.id)));
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
        eyebrow={t('mgr.ap.eyebrow', { role: access.managesTeams ? t('mgr.role.teamManager') : t('mgr.role.orgAdmin') })}
        title={t('nav.approvals')}
        description={
          items.length
            ? tPlural(items.length, 'mgr.ap.waiting.one', 'mgr.ap.waiting.other')
            : t('mgr.ap.empty', { expenses: expenseReview ? t('mgr.ap.andExpenses') : '' })
        }
      />
      {access.managesTeams && !me.entitlements.includes('correction_approvals') ? (
        <Banner tag="NOTE" title={t('mgr.ap.noWorkflowTitle')}>
          {t('mgr.ap.noWorkflowBody')}
        </Banner>
      ) : null}

      <div role="tablist" aria-label={t('mgr.ap.requestType')} className={s.tabs}>
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            role="tab"
            aria-selected={tab === tb.key}
            className={tab === tb.key ? s.tabOn : s.tab}
            onClick={() => setTab(tb.key)}
          >
            {inboxTabLabel(tb.key)} <span className="mono">{counts[tb.key]}</span>
          </button>
        ))}
      </div>

      {summary ? (
        <Banner role="status" title={summary} actions={<Button variant="link" onClick={() => setSummary(null)}>{t('common.dismiss')}</Button>} />
      ) : null}
      {chosen.length > 0 ? (
        <section aria-label={t('mgr.ap.selected')} className={s.selectionBar}>
          <strong>{t('mgr.ap.nSelected', { n: chosen.length })}</strong>
          <span className={s.selectionNote}>
            {t('mgr.ap.eachChecked')}
            {chosenDeletions ? tPlural(chosenDeletions, 'mgr.ap.deletesShots.one', 'mgr.ap.deletesShots.other') : ''}
          </span>
          <span className={s.grow} />
          <Button size="sm" variant="quiet" onClick={() => setSelected(new Set())}>
            {t('mgr.ap.clear')}
          </Button>
          <Button size="sm" onClick={() => setSendingBack(true)} disabled={batch.busy}>
            {t('mgr.ap.sendBackNote')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => run('approve')} disabled={batch.busy}>
            {batch.busy ? t('mgr.ap.working') : t('mgr.ap.approveN', { n: chosen.length })}
          </Button>
        </section>
      ) : null}
      {!sendingBack ? <ActionError error={batch.error} /> : null}

      {error ? (
        <ErrorState error={error} onRetry={() => sources.forEach((x) => x.reload())} />
      ) : loading ? (
        <Loading label={t('mgr.ap.loading')} />
      ) : visible.length === 0 ? (
        <Card>
          <Empty title={t('mgr.ap.nothing')}>
            {t('mgr.ap.nothingBody', {
              expense: expenseReview ? t('mgr.ap.claimsExpense') : '',
              deletion: access.isAdmin ? t('mgr.ap.asksDelete') : '',
            })}
          </Empty>
        </Card>
      ) : (
        <div className={s.inbox}>
          <Card label={t('mgr.ap.requests')} className={s.list}>
            <div onKeyDown={onKeys}>
              <TableBox label={t('mgr.ap.requestsWaiting')}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col" className={s.check}>
                        <input type="checkbox" aria-label={t('mgr.ap.selectAll')} checked={allVisibleChosen} onChange={toggleAll} />
                      </th>
                      <th scope="col">{t('mgr.ap.personRequest')}</th>
                      <th scope="col">{t('mgr.ap.type')}</th>
                      <th scope="col" className={numClass}>
                        {t('mgr.ap.amount')}
                      </th>
                      <th scope="col">{t('mgr.ap.waitingCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => {
                      const k = itemKey(i);
                      const isFocus = focused !== null && itemKey(focused) === k;
                      return (
                        <tr key={k} className={isFocus ? s.rowFocus : undefined} aria-current={isFocus ? 'true' : undefined}>
                          <td className={s.check}>
                            <input type="checkbox" aria-label={t('mgr.ap.select', { who: i.who, what: i.what })} checked={selected.has(k)} onChange={() => toggle(i)} />
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
              <p className="small muted">{t('mgr.ap.keys')}</p>
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
              <TimesheetReviewCard key={itemKey(focused)} sheet={sheets.data!.find((sh) => sh.id === focused.id)!} tz={tz} onDone={onDone(focused)} />
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
        title={tPlural(chosen.length, 'mgr.ap.sendBackTitle.one', 'mgr.ap.sendBackTitle.other')}
        description={t('mgr.ap.sendBackBody')}
        footer={
          <>
            <Button onClick={() => setSendingBack(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => run('reject', note.trim())} disabled={batch.busy || note.trim().length < 3}>
              {batch.busy ? t('mgr.ap.sending') : t('mgr.ap.sendBack')}
            </Button>
          </>
        }
      >
        <TextArea label={t('mgr.ap.noteReq')} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        <ActionError error={batch.error} />
      </Dialog>
    </>
  );
}
