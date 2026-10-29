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
import { t } from '@/lib/i18n';
import s from './day.module.css';

const statusText = (st: ScreenshotDTO['status']): string => (st === 'stored' ? '' : t(`shots.status.${st}`));
const deletionText = (d: NonNullable<ScreenshotDTO['deletion_request_status']>): string => t(`shots.deletion.${d}`);

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
    <Card title={t('day.screenshots')} subtitle={policyText}>
      {!isSelf ? (
        <span className={s.recorded}>
          <CameraIcon /> {personName ? t('shots.viewingRecordedFor', { name: personName }) : t('shots.viewingRecorded')}
        </span>
      ) : null}
      {sorted.length === 0 ? (
        <p className="secondary">{t('shots.none')}</p>
      ) : (
        <ul className={s.shots}>
          {sorted.map((shot) => {
            const time = formatTime(shot.captured_at, tz);
            const viewable = shot.status === 'stored';
            const status = statusText(shot.status);
            const deletion = shot.deletion_request_status ? deletionText(shot.deletion_request_status) : null;
            return (
              <li key={shot.id} className={s.shot}>
                <button
                  type="button"
                  className={s.thumb}
                  disabled={!viewable}
                  onClick={() => open(shot)}
                  aria-label={viewable ? t('shots.viewFrom', { time }) : t('shots.from', { time, status })}
                >
                  <span className={s.thumbBar} aria-hidden="true" />
                  <span className={s.thumbBody} aria-hidden="true">
                    <span className={s.thumbSide} />
                    <span className={s.thumbMain}>{viewable ? t('shots.view') : status}</span>
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
                      {t('shots.requestDeletion')}
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
        title={viewing ? t('shots.titleAt', { when: formatDateTime(viewing.captured_at, tz) }) : t('shots.title')}
        description={
          isSelf
            ? t('shots.keptUntil', { when: viewing ? formatDateTime(viewing.retention_after, tz) : '—' })
            : personName
              ? t('shots.viewAuditedFor', { name: personName })
              : t('shots.viewAudited')
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
            alt={t('shots.alt', { time: formatTime(viewing.captured_at, tz) })}
            width={viewing.width ?? undefined}
            height={viewing.height ?? undefined}
          />
        ) : (
          <Loading label={t('shots.loadingLink')} />
        )}
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
          del.reset();
        }}
        title={t('shots.requestDeletion')}
        description={deleting ? t('shots.deletionBody', { when: formatDateTime(deleting.captured_at, tz) }) : undefined
        }
        footer={
          <div className={formActionsClass}>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={del.busy || reason.trim().length < 3} onClick={submitDeletion}>
              {del.busy ? t('shots.sending') : t('shots.requestDeletion')}
            </Button>
          </div>
        }
      >
        <TextArea
          label={t('shots.reason')}
          hint={t('shots.reasonHint')}
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
