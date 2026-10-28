'use client';

import { useState } from 'react';
import type { CorrectionDTO, CorrectionValues } from '@rd/contracts';
import { TimesheetApprovals } from '@/components/timesheet/TimesheetApprovals';
import { TimeOffApprovals } from '@/components/scheduling/TimeOffApprovals';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { TextArea } from '@/components/ui/Field';
import { Banner, Card, PageHeader, dlClass, formActionsClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatDuration, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { can } from '@/lib/nav';
import { dateInTz, formatDateTime, formatShortDay, formatTime } from '@/lib/time';
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
  const pending = useApi(access.managesTeams ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const projects = useApi(access.managesTeams ? 'projects:managed' : null, (signal) => rd.projects.list(signal).catch(() => []));
  const projectName = (id: string | null) => {
    if (!id) return 'No project';
    return projects.data?.find((p) => p.id === id)?.name ?? `Project ${id.slice(0, 8)}`;
  };
  if (!can(access, 'approvals')) return <NoAccess what="Approvals are for team managers." />;
  const timesheets = access.entitlements.includes('timesheets');
  const timeOffReview = access.entitlements.includes('time_off');

  return (
    <>
      <PageHeader
        eyebrow={`${access.managesTeams ? 'Team manager' : 'Org admin'} · ${timesheets ? 'Corrections and timesheets' : 'Corrections'}`}
        title="Approvals"
        description={
          access.managesTeams
            ? 'Corrections, manual time, timesheets and time off from people in your teams. Original values are kept whatever you decide.'
            : 'Timesheets and time off from people across the organization. You cannot approve your own.'
        }
      />
      {timesheets ? <TimesheetApprovals tz={tz} /> : null}
      {access.managesTeams ? (
        <>
          {timesheets ? <h2>Corrections and manual time</h2> : null}
          {!me.entitlements.includes('correction_approvals') ? (
            <Banner tag="NOTE" title="Your plan doesn't include the approval workflow">
              An org admin can turn it on by moving to Standard or Pro.
            </Banner>
          ) : null}
          <Resource {...pending} label="Loading pending corrections">
            {(list) =>
              list.length === 0 ? (
                <Card>
                  <Empty title="Nothing to review">When someone proposes a correction or adds manual time, it shows up here.</Empty>
                </Card>
              ) : (
                <>
                  <p className="secondary">{plural(list.length, 'request')} waiting, oldest first.</p>
                  {[...list]
                    .sort((a, b) => a.created_at.localeCompare(b.created_at))
                    .map((c) => (
                      <Review
                        key={c.id}
                        c={c}
                        tz={tz}
                        projectName={projectName}
                        onDone={(id) => pending.mutate((prev) => prev?.filter((x) => x.id !== id))}
                      />
                    ))}
                </>
              )
            }
          </Resource>
        </>
      ) : null}
      {timeOffReview ? <TimeOffApprovals tz={tz} /> : null}
    </>
  );
}
