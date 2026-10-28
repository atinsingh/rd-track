'use client';

import { useState } from 'react';
import type { ScreenshotDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { Card, formActionsClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError } from '@/lib/api';
import { formatDateTime, formatTime } from '@/lib/time';
import { useAction } from '@/lib/useApi';
import s from './day.module.css';

const STATUS_TEXT: Record<ScreenshotDTO['status'], string> = {
  pending: 'Uploading',
  verifying: 'Checking',
  stored: '',
  deleted: 'Deleted',
  failed: 'Upload failed',
};

const DELETION_TEXT = {
  pending: 'Deletion requested',
  approved: 'Deletion approved',
  rejected: 'Deletion declined',
} as const;

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <circle cx="12" cy="13.5" r="3.5" />
      <path d="M9 7l1.5-3h3L15 7" />
    </svg>
  );
}
export { CameraIcon };

/**
 * Screenshot strip. Images are never fetched up front: each tile requests a 60-second
 * view URL only when opened, and that view is audited (system design §6.5).
 */
export function ScreenshotStrip({
  shots,
  tz,
  isSelf,
  personName,
  policyText,
  onDeletionRequested,
}: {
  shots: readonly ScreenshotDTO[];
  tz: string;
  isSelf: boolean;
  personName?: string;
  policyText?: string;
  onDeletionRequested?: (id: string) => void;
}) {
  const [viewing, setViewing] = useState<ScreenshotDTO | null>(null);
  const [url, setUrl] = useState<{ id: string; url: string; expires: string } | null>(null);
  const [viewError, setViewError] = useState<ApiError | null>(null);
  const [deleting, setDeleting] = useState<ScreenshotDTO | null>(null);
  const [reason, setReason] = useState('');
  const del = useAction();
  const sorted = [...shots].sort((a, b) => a.captured_at.localeCompare(b.captured_at));

  const open = async (shot: ScreenshotDTO) => {
    setViewing(shot);
    setUrl(null);
    setViewError(null);
    try {
      const r = await rd.screenshotViewUrl(shot.id);
      setUrl({ id: shot.id, url: r.url, expires: r.expires_at });
    } catch (e) {
      setViewError(toApiError(e));
    }
  };

  const submitDeletion = async () => {
    if (!deleting) return;
    const res = await del.run(() => rd.my.requestDeletion(deleting.id, reason.trim()));
    if (res) {
      onDeletionRequested?.(deleting.id);
      setDeleting(null);
      setReason('');
    }
  };

  return (
    <Card title="Screenshots" subtitle={policyText}>
      {!isSelf ? (
        <span className={s.recorded}>
          <CameraIcon /> Viewing is recorded{personName ? ` and shown to ${personName}` : ''}
        </span>
      ) : null}
      {sorted.length === 0 ? (
        <p className="secondary">No screenshots in this period.</p>
      ) : (
        <ul className={s.shots}>
          {sorted.map((shot) => {
            const time = formatTime(shot.captured_at, tz);
            const viewable = shot.status === 'stored';
            const status = STATUS_TEXT[shot.status];
            const deletion = shot.deletion_request_status ? DELETION_TEXT[shot.deletion_request_status] : null;
            return (
              <li key={shot.id} className={s.shot}>
                <button
                  type="button"
                  className={s.thumb}
                  disabled={!viewable}
                  onClick={() => open(shot)}
                  aria-label={viewable ? `View screenshot from ${time}` : `Screenshot from ${time}: ${status}`}
                >
                  <span className={s.thumbBar} aria-hidden="true" />
                  <span className={s.thumbBody} aria-hidden="true">
                    <span className={s.thumbSide} />
                    <span className={s.thumbMain}>{viewable ? 'View' : status}</span>
                  </span>
                </button>
                <span className={s.shotCaption}>
                  <span>
                    <span className="mono">{time}</span>
                    {shot.app_name ? ` · ${shot.app_name}` : ''}
                    {deletion ? ` · ${deletion}` : status ? ` · ${status}` : ''}
                  </span>
                  {isSelf && viewable && !shot.deletion_request_status ? (
                    <Button variant="link" onClick={() => setDeleting(shot)} style={{ alignSelf: 'flex-start', fontSize: 12 }}>
                      Request deletion
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => {
          setViewing(null);
          setUrl(null);
        }}
        size="lg"
        title={viewing ? `Screenshot · ${formatDateTime(viewing.captured_at, tz)}` : 'Screenshot'}
        description={
          isSelf
            ? `Kept until ${viewing ? formatDateTime(viewing.retention_after, tz) : '—'}.`
            : `This view is recorded in the audit log${personName ? ` and shown to ${personName}` : ''}.`
        }
      >
        {viewError ? (
          <ErrorState error={viewError} />
        ) : url && viewing && url.id === viewing.id ? (
          // Presigned object-storage URL, valid for 60 seconds; not optimisable by next/image.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={s.viewer}
            src={url.url}
            alt={`Screenshot captured at ${formatTime(viewing.captured_at, tz)}`}
            width={viewing.width ?? undefined}
            height={viewing.height ?? undefined}
          />
        ) : (
          <Loading label="Requesting a short-lived link" />
        )}
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
          del.reset();
        }}
        title="Request deletion"
        description={
          deleting
            ? `Screenshot from ${formatDateTime(deleting.captured_at, tz)}. Depending on policy it is deleted right away or after an admin review. The request is recorded; the image is never shown to the reviewer.`
            : undefined
        }
        footer={
          <div className={formActionsClass}>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="primary" disabled={del.busy || reason.trim().length < 3} onClick={submitDeletion}>
              {del.busy ? 'Sending…' : 'Request deletion'}
            </Button>
          </div>
        }
      >
        <TextArea
          label="Reason (required)"
          hint="For example: a personal message was on screen."
          value={reason}
          maxLength={1000}
          rows={3}
          onChange={(e) => setReason(e.target.value)}
        />
        <ActionError error={del.error} />
      </Dialog>
    </Card>
  );
}
