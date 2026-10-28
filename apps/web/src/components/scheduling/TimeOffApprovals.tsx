'use client';

import { useState } from 'react';
import type { TimeOffRequestDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { TextArea } from '@/components/ui/Field';
import { Card, dlClass, formActionsClass } from '@/components/ui/Layout';
import { plural } from '@/lib/format';
import { dateSpanLabel, formatHours, sched } from '@/lib/scheduling';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from './scheduling.module.css';

function Review({ r, tz, onDone }: { r: TimeOffRequestDTO; tz: string; onDone: (id: string) => void }) {
  const [note, setNote] = useState('');
  const action = useAction();
  const decide = async (approve: boolean) => {
    const n = note.trim() || undefined;
    const done = await action.run(() => (approve ? sched.review.approve(r.id, n) : sched.review.deny(r.id, n)));
    if (done) onDone(r.id);
  };
  return (
    <Card title={`${r.user_name} · ${r.policy_name}`} subtitle={`Requested ${formatDateTime(r.created_at, tz)}`}>
      <div className={s.compare}>
        <div className={s.side}>
          <span className="label-mono">Time off</span>
          <dl className={dlClass}>
            <dt>Dates</dt>
            <dd>{dateSpanLabel(r.start_date, r.end_date)}</dd>
            <dt>Hours</dt>
            <dd className="mono">
              {formatHours(r.hours)}
              {r.partial_hours !== null ? ' (part of a day)' : ''}
            </dd>
            <dt>Policy</dt>
            <dd>
              {r.policy_name} · {r.policy_kind}
            </dd>
          </dl>
        </div>
        <div className={s.side}>
          <span className="label-mono">Note from {r.user_name}</span>
          <p>{r.reason ? `“${r.reason}”` : <span className="secondary">No note.</span>}</p>
        </div>
      </div>
      <TextArea label="Note to the employee (optional)" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => decide(false)} disabled={action.busy}>
          Don&apos;t approve
        </Button>
        <Button variant="primary" onClick={() => decide(true)} disabled={action.busy}>
          Approve
        </Button>
      </div>
    </Card>
  );
}

/** Pending time-off requests the signed-in manager or org admin may review (never their own). */
export function TimeOffApprovals({ tz }: { tz: string }) {
  const pending = useApi('timeoff:pending', (signal) => sched.review.pending(signal));
  return (
    <section className="stack" aria-labelledby="time-off-approvals">
      <h2 id="time-off-approvals">Time off</h2>
      <Resource {...pending} label="Loading time-off requests">
        {(list) =>
          list.length === 0 ? (
            <Card>
              <Empty title="No time off to review">Requests from people in your teams show up here.</Empty>
            </Card>
          ) : (
            <>
              <p className="secondary">{plural(list.length, 'request')} waiting, oldest first. Approving deducts the hours from the person&apos;s balance.</p>
              {list.map((r) => (
                <Review key={r.id} r={r} tz={tz} onDone={(id) => pending.mutate((prev) => prev?.filter((x) => x.id !== id))} />
              ))}
            </>
          )
        }
      </Resource>
    </section>
  );
}
