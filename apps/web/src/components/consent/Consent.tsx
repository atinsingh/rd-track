'use client';

import { useState } from 'react';
import type { AdminConsentResponse, ConsentStatus, PersonConsentResponse } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { TextArea } from '@/components/ui/Field';
import { Badge, Banner, Card, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t, type MessageKey } from '@/lib/i18n';
import { formatDateTime } from '@/lib/time';
import { useAction, type ApiResource } from '@/lib/useApi';

const STATUS_KEY: Record<ConsentStatus, MessageKey> = {
  pending: 'consent.status.pending',
  accepted: 'consent.status.accepted',
  declined: 'consent.status.declined',
};

export function ConsentBadge({ status }: { status: ConsentStatus }) {
  return <Badge tone={status === 'accepted' ? 'outline' : 'warn'}>{t(STATUS_KEY[status])}</Badge>;
}

/** Manager or admin: ask someone to answer again. Recorded and audited; the app shows the agreement on its next check. */
export function AskAgain({ userId, onAsked }: { userId: string; onAsked?: (c: PersonConsentResponse) => void }) {
  const action = useAction();
  const [asked, setAsked] = useState(false);
  if (asked) return <span className="small secondary">{t('consent.askedNow')}</span>;
  return (
    <>
      <Button
        size="sm"
        variant="quiet"
        disabled={action.busy}
        onClick={async () => {
          const r = await action.run(() => rd.consent.askAgain(userId));
          if (r) {
            setAsked(true);
            onAsked?.(r);
          }
        }}
      >
        {t('consent.askAgain')}
      </Button>
      <ActionError error={action.error} />
    </>
  );
}

/** Team page: who can't be tracked yet, so someone follows up. HR decides on a continued refusal. */
export function ConsentNotice({ members }: { members: { consent?: ConsentStatus }[] }) {
  const declined = members.filter((m) => m.consent === 'declined').length;
  const pending = members.filter((m) => m.consent === 'pending').length;
  if (!declined && !pending) return null;
  return (
    <Banner tone="warn" role="status" title={t('consent.notice.title', { declined, pending })}>
      {t('consent.notice.body')}
    </Banner>
  );
}

/** Every accept and decline, newest first, with what was shown and where it came from. */
export function ConsentRecords({
  res,
  tz,
  title,
  userId,
  records = true,
}: {
  res: ApiResource<PersonConsentResponse>;
  tz: string;
  title: string;
  /** Shows "Ask again" (managers and admins) when they declined or haven't answered. */
  userId?: string;
  /** false: status only (managers don't see the stored answers). */
  records?: boolean;
}) {
  const c = res.data;
  return (
    <Card
      title={title}
      actions={
        c ? (
          <span className="row">
            <ConsentBadge status={c.status} />
            {userId && c.status !== 'accepted' ? <AskAgain userId={userId} onAsked={(next) => res.mutate(() => next)} /> : null}
          </span>
        ) : null
      }
    >
      <Resource {...res} label={t('common.loading')}>
        {(c) =>
          !records ? (
            <p className="small secondary">
              {t(c.status === 'accepted' ? 'consent.followAccepted' : 'consent.follow')}
              {c.asked_again_at ? ` ${t('consent.askedAt', { when: formatDateTime(c.asked_again_at, tz) })}` : ''}
            </p>
          ) : c.records.length === 0 ? (
            <Empty title={t('consent.none')}>{t('consent.noneBody', { n: c.required_version })}</Empty>
          ) : (
            <TableBox label={title}>
              <table className={tableClass} style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th scope="col">{t('consent.when')}</th>
                    <th scope="col">{t('consent.answer')}</th>
                    <th scope="col">{t('consent.version')}</th>
                    <th scope="col">{t('consent.computer')}</th>
                    <th scope="col">{t('consent.ip')}</th>
                    <th scope="col">{t('consent.text')}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.records.map((r) => (
                    <tr key={r.id}>
                      <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(r.decided_at, tz)}
                      </td>
                      <td>{t(STATUS_KEY[r.decision])}</td>
                      <td className="mono">{r.version}</td>
                      <td>{r.device_name}</td>
                      <td className="mono small">{r.ip}</td>
                      <td>
                        <details>
                          <summary className="mono small" title={r.text_sha256}>
                            {t('consent.hash', { hash: r.text_sha256.slice(0, 12) })}
                          </summary>
                          <p className="small secondary" style={{ whiteSpace: 'pre-wrap', maxWidth: 520 }}>
                            {r.text}
                          </p>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
          )
        }
      </Resource>
    </Card>
  );
}

/** Admin → Policies: the agreement people answer in the desktop app. Saving always starts a new version. */
export function AgreementEditor({ res, tz }: { res: ApiResource<AdminConsentResponse>; tz: string }) {
  return (
    <Card title={t('consent.adm.title')} subtitle={t('consent.adm.subtitle')}>
      <Resource {...res} label={t('common.loading')}>
        {(a) => <AgreementForm key={a.version} agreement={a} tz={tz} onSaved={(next) => res.mutate(() => next)} />}
      </Resource>
    </Card>
  );
}

function AgreementForm({ agreement: a, tz, onSaved }: { agreement: AdminConsentResponse; tz: string; onSaved: (a: AdminConsentResponse) => void }) {
  const [text, setText] = useState(a.custom_text ?? a.generated_text);
  const action = useAction();
  const save = async (custom: string | null) => {
    const r = await action.run(() => rd.consent.setText(custom));
    if (r) onSaved(r);
  };
  const unchanged = text.trim() === (a.custom_text ?? a.generated_text).trim();
  const latest = a.history[0];
  return (
    <div className="stack">
      <Banner tone="warn" title={t('consent.adm.lawyerTitle')}>
        {t('consent.adm.lawyer')}
      </Banner>
      <p className="small secondary">
        {t('consent.adm.current', { n: a.version })}
        {latest?.created_at ? ` · ${formatDateTime(latest.created_at, tz)}` : ''}
        {' · '}
        {a.custom_text === null ? t('consent.adm.generated') : t('consent.adm.custom')}
      </p>
      <TextArea
        label={t('consent.adm.text')}
        hint={t('consent.adm.hint')}
        value={text}
        rows={16}
        maxLength={20000}
        onChange={(e) => setText(e.target.value)}
      />
      <ActionError error={action.error} />
      <div className="row">
        <Button variant="primary" disabled={action.busy || unchanged || !text.trim()} onClick={() => void save(text.trim())}>
          {t('consent.adm.save')}
        </Button>
        {a.custom_text !== null ? (
          <Button variant="quiet" disabled={action.busy} onClick={() => void save(null)}>
            {t('consent.adm.reset')}
          </Button>
        ) : null}
      </div>
      <details>
        <summary className="small">{t('consent.adm.history')}</summary>
        <ul className="small secondary">
          {a.history.map((h) => (
            <li key={h.version}>
              {t('consent.adm.historyRow', { n: h.version, reason: t(`consent.reason.${h.reason}` as MessageKey) })}
              {h.created_at ? ` · ${formatDateTime(h.created_at, tz)}` : ''}
              {h.created_by ? ` · ${h.created_by}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
