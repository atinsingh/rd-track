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

/** Every accept and decline, newest first, with what was shown and where it came from. */
export function ConsentRecords({ res, tz, title }: { res: ApiResource<PersonConsentResponse>; tz: string; title: string }) {
  return (
    <Card title={title} actions={res.data ? <ConsentBadge status={res.data.status} /> : null}>
      <Resource {...res} label={t('common.loading')}>
        {(c) =>
          c.records.length === 0 ? (
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
