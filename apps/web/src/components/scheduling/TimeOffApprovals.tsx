'use client';

import { useState } from 'react';
import type { TimeOffRequestDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextArea } from '@/components/ui/Field';
import { Card, dlClass, formActionsClass } from '@/components/ui/Layout';
import { dateSpanLabel, formatHours, sched } from '@/lib/scheduling';
import { formatDateTime } from '@/lib/time';
import { useAction } from '@/lib/useApi';
import s from './scheduling.module.css';

/** One time-off request, reviewed on its own (detail panel of the approvals inbox). */
export function TimeOffReviewCard({ r, tz, onDone }: { r: TimeOffRequestDTO; tz: string; onDone: (id: string) => void }) {
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
