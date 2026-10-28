'use client';

import { useState, type KeyboardEvent } from 'react';
import type { CorrectionDTO, CorrectionValues } from '@rd/contracts';
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
import { formatDuration, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { can } from '@/lib/nav';
import { sched } from '@/lib/scheduling';
import { dateInTz, formatDateTime, formatRelative, formatShortDay, formatTime } from '@/lib/time';
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

export default function ApprovalsPage() {
  const { access, timezone: tz, me } = useMe();
  const timesheets = access.entitlements.includes('timesheets');
  const timeOffReview = access.entitlements.includes('time_off');
  // Org admins review corrections from people with no team manager, so they load them too.
  const corrections = useApi(access.managesTeams || access.isAdmin ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const sheets = useApi(timesheets ? 'timesheets:pending' : null, (signal) => timesheetsApi.pending(signal));
  const leave = useApi(timeOffReview ? 'timeoff:pending' : null, (signal) => sched.review.pending(signal));
  const projects = useApi(access.managesTeams ? 'projects:managed' : null, (signal) => rd.projects.list(signal).catch(() => []));
  const [tab, setTab] = useState<InboxTab>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const batch = useAction();

  if (!can(access, 'approvals')) return <NoAccess what="Approvals are for team managers." />;

  const sources = [corrections, sheets, leave];
  const error = sources.find((x) => x.error)?.error;
  const loading = sources.some((x) => x.loading && !x.data);
  const items = inboxItems(corrections.data ?? [], sheets.data ?? [], leave.data ?? [], tz);
  const visible = inTab(items, tab);
  const counts = Object.fromEntries(INBOX_TABS.map((t) => [t.key, inTab(items, t.key).length])) as Record<InboxTab, number>;
  const chosen = items.filter((i) => selected.has(itemKey(i)));
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
    corrections.mutate((prev) => prev?.filter((x) => !c.has(x.id)));
    sheets.mutate((prev) => prev?.filter((x) => !x.id || !t.has(x.id)));
    leave.mutate((prev) => prev?.filter((x) => !o.has(x.id)));
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
            : 'Corrections, manual time, timesheets and time off from the people you review. Originals are kept whatever you decide.'
        }
      />
      {access.managesTeams && !me.entitlements.includes('correction_approvals') ? (
        <Banner tag="NOTE" title="Your plan doesn't include the approval workflow">
          Corrections apply straight away. An org admin can turn approvals on by moving to Standard or Pro.
        </Banner>
      ) : null}

      <div role="tablist" aria-label="Request type" className={s.tabs}>
        {INBOX_TABS.map((t) => (
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
          <span className={s.selectionNote}>Each is checked on its own; anything that can&apos;t be done is listed after.</span>
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
          <Empty title="Nothing to review">When someone submits a timesheet, adds or corrects time, or asks for time off, it shows up here.</Empty>
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
