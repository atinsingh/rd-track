'use client';

import { useState, type FormEvent } from 'react';
import { timeCorrectionRequest, type CorrectionDTO, type SessionDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextArea, TextField } from '@/components/ui/Field';
import { formActionsClass, formGridClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { addDays, formatDayLabel, formatTime, toZonedInputs, todayInTz, zonedTimeToMs } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';

export interface CorrectionDraft {
  date: string;
  start: string;
  end: string;
  projectId: string;
  taskId: string;
  reason: string;
}

export function draftFor(session: SessionDTO | null, tz: string, date?: string): CorrectionDraft {
  if (session) {
    const a = toZonedInputs(session.started_at, tz);
    const b = session.ended_at ? toZonedInputs(session.ended_at, tz) : { time: formatTime(Date.now(), tz) };
    return { date: a.date, start: a.time, end: b.time, projectId: session.project_id ?? '', taskId: session.task_id ?? '', reason: '' };
  }
  return { date: date ?? todayInTz(tz), start: '09:00', end: '09:30', projectId: '', taskId: '', reason: '' };
}

/** Converts the local form to the API body; an end at or before the start means the next day. */
export function draftToRequest(d: CorrectionDraft, tz: string, sessionId?: string) {
  const startMs = zonedTimeToMs(d.date, d.start, tz);
  let endMs = zonedTimeToMs(d.date, d.end, tz);
  if (endMs <= startMs) endMs = zonedTimeToMs(addDays(d.date, 1), d.end, tz);
  return {
    body: {
      ...(sessionId ? { session_id: sessionId } : {}),
      requested: {
        started_at: new Date(startMs).toISOString(),
        ended_at: new Date(endMs).toISOString(),
        project_id: d.projectId || null,
        task_id: d.taskId || null,
      },
      reason: d.reason.trim(),
    },
    seconds: (endMs - startMs) / 1000,
  };
}

/**
 * "Propose a correction" side sheet (UX §3.2). With a session it proposes an edit;
 * without one it adds manual time. Original values are kept and shown to the manager.
 */
export function CorrectionSheet({
  open,
  onClose,
  session,
  tz,
  defaultDate,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionDTO | null;
  tz: string;
  defaultDate?: string;
  onSubmitted: (c: CorrectionDTO) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="sheet"
      eyebrow={session ? t('corr.eyebrowCorrection') : t('corr.eyebrowManual')}
      title={session ? t('corr.titleCorrection') : t('corr.titleManual')}
      description={t('corr.description')}
    >
      {open ? (
        <SheetForm
          key={session?.id ?? `new-${defaultDate ?? ''}`}
          session={session}
          tz={tz}
          defaultDate={defaultDate}
          onCancel={onClose}
          onSubmitted={onSubmitted}
        />
      ) : null}
    </Dialog>
  );
}

function SheetForm({
  session,
  tz,
  defaultDate,
  onCancel,
  onSubmitted,
}: {
  session: SessionDTO | null;
  tz: string;
  defaultDate?: string;
  onCancel: () => void;
  onSubmitted: (c: CorrectionDTO) => void;
}) {
  const [d, setD] = useState<CorrectionDraft>(() => draftFor(session, tz, defaultDate));
  const [error, setError] = useState<string | null>(null);
  const projects = useApi('me:projects', (signal) => rd.my.projects(signal));
  const action = useAction();
  const project = projects.data?.find((p) => p.id === d.projectId);
  const set = (patch: Partial<CorrectionDraft>) => setD((prev) => ({ ...prev, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const { body, seconds } = draftToRequest(d, tz, session?.id);
    if (seconds > 24 * 3600) return setError(t('corr.max24'));
    const parsed = timeCorrectionRequest.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(issue?.path.includes('reason') ? t('corr.reasonShort') : (issue?.message ?? t('corr.check')));
    }
    const res = await action.run(() => rd.my.proposeCorrection(body));
    if (res) onSubmitted(res);
  };

  const preview = (() => {
    try {
      return draftToRequest(d, tz).seconds;
    } catch {
      return null;
    }
  })();

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} noValidate>
      {session ? (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '90px 1fr', gap: '4px 12px', background: 'var(--canvas)', padding: '10px 12px' }}>
          <dt className="muted">{t('corr.session')}</dt>
          <dd style={{ margin: 0 }}>
            {formatDayLabel(toZonedInputs(session.started_at, tz).date)},{' '}
            <span className="mono">
              {formatTime(session.started_at, tz)} → {session.ended_at ? formatTime(session.ended_at, tz) : t('session.now')}
            </span>
            {session.project_name ? `, ${session.project_name}` : ''}
          </dd>
        </dl>
      ) : null}
      <div className={formGridClass}>
        <TextField label={t('corr.date')} type="date" required value={d.date} onChange={(e) => set({ date: e.target.value })} />
        <TextField label={session ? t('corr.newStart') : t('corr.start')} type="time" required value={d.start} onChange={(e) => set({ start: e.target.value })} />
        <TextField
          label={session ? t('corr.newEnd') : t('corr.end')}
          type="time"
          required
          value={d.end}
          onChange={(e) => set({ end: e.target.value })}
          hint={preview !== null ? `${formatDuration(preview)}${d.end <= d.start ? t('corr.endsNextDay') : ''} · ${tz}` : undefined}
        />
      </div>
      {projects.error ? (
        <ErrorState error={projects.error} onRetry={projects.reload} title={t('corr.projectsFailed')} />
      ) : (
        <div className={formGridClass}>
          <SelectField
            label={t('corr.project')}
            value={d.projectId}
            onChange={(e) => set({ projectId: e.target.value, taskId: '' })}
            disabled={!projects.data}
          >
            <option value="">{t('corr.noProject')}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {d.projectId && projects.data && !project ? <option value={d.projectId}>{session?.project_name ?? t('corr.currentProject')}</option> : null}
          </SelectField>
          <SelectField label={t('corr.task')} value={d.taskId} onChange={(e) => set({ taskId: e.target.value })} disabled={!project || project.tasks.length === 0}>
            <option value="">{t('corr.noTask')}</option>
            {project?.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      <TextArea
        label={t('corr.reason')}
        required
        rows={3}
        maxLength={1000}
        value={d.reason}
        placeholder={t('corr.reasonPlaceholder')}
        onChange={(e) => set({ reason: e.target.value })}
      />
      {error ? (
        <p role="alert" style={{ color: 'var(--danger-text)', fontWeight: 500 }}>
          {error}
        </p>
      ) : null}
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={action.busy}>
          {action.busy ? t('ts.submitting') : t('ts.submit')}
        </Button>
      </div>
    </form>
  );
}
