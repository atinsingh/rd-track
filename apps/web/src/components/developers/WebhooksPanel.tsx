'use client';

import { useState } from 'react';
import { WEBHOOK_EVENTS, type WebhookEndpointDTO, type WebhookEventType } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from '@/app/(app)/admin/admin.module.css';

const eventLabel = (e: WebhookEventType) => t(`cfg.hook.ev.${e}`);

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [url, setUrl] = useState('https://');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>(['session.started', 'session.stopped']);
  const [created, setCreated] = useState<WebhookEndpointDTO | null>(null);
  const action = useAction();
  const close = () => {
    setCreated(null);
    setUrl('https://');
    setDescription('');
    action.reset();
    onClose();
  };
  const create = async () => {
    const r = await action.run(() => rd.admin.createWebhook({ url: url.trim(), description: description.trim() || undefined, events }));
    if (r) {
      setCreated(r);
      onCreated();
    }
  };
  const toggle = (e: WebhookEventType, on: boolean) => setEvents((prev) => (on ? [...prev, e] : prev.filter((x) => x !== e)));
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      eyebrow={t('cfg.hook.eyebrow')}
      title={created ? t('cfg.hook.secretTitle') : t('cfg.hook.newTitle')}
      description={created ? t('cfg.hook.secretBody') : t('cfg.hook.newBody')}
      footer={
        created ? (
          <>
            <CopyButton text={created.signing_secret ?? ''} label={t('cfg.hook.copySecret')} />
            <Button variant="primary" onClick={close}>
              {t('cfg.hook.done')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={create} disabled={action.busy || events.length === 0 || !url.startsWith('https://')}>
              {action.busy ? t('cfg.tok.creating') : t('cfg.hook.create')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className={s.secret} aria-label={t('cfg.hook.secretTitle')}>
          {created.signing_secret}
        </div>
      ) : (
        <>
          <TextField label={t('cfg.hook.url')} type="url" value={url} onChange={(e) => setUrl(e.target.value)} hint={t('cfg.hook.urlHint')} />
          <TextField label={t('cfg.hook.description')} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">{t('cfg.hook.events')}</legend>
            {WEBHOOK_EVENTS.map((e) => (
              <Checkbox key={e} label={eventLabel(e)} checked={events.includes(e)} onChange={(ev) => toggle(e, ev.target.checked)} />
            ))}
          </fieldset>
          <ActionError error={action.error} />
        </>
      )}
    </Dialog>
  );
}

function Deliveries({ id }: { id: string }) {
  const { timezone: tz } = useMe();
  const d = useApi(`admin:webhook-deliveries|${id}`, (signal) => rd.admin.webhookDeliveries(id, signal));
  return (
    <Resource {...d} label={t('cfg.hook.loadingDeliveries')}>
      {(list) =>
        list.length === 0 ? (
          <p className="small muted">{t('cfg.hook.noDeliveries')}</p>
        ) : (
          <TableBox label={t('cfg.hook.recent')}>
            <table className={tableClass} style={{ minWidth: 600 }}>
              <thead>
                <tr>
                  <th scope="col">{t('cfg.hook.colEvent')}</th>
                  <th scope="col">{t('cfg.hook.colStatus')}</th>
                  <th scope="col" className={numClass}>
                    {t('cfg.hook.colAttempts')}
                  </th>
                  <th scope="col">{t('cfg.hook.colResponse')}</th>
                  <th scope="col">{t('cfg.hook.colCreated')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id}>
                    <td className="mono small">{x.event_type}</td>
                    <td>
                      <Badge tone={x.status === 'delivered' ? 'solid' : x.status === 'failed' ? 'warn' : 'outline'}>{t(`cfg.hook.status.${x.status}`)}</Badge>
                    </td>
                    <td className={numClass}>{x.attempts}</td>
                    <td className="small">{x.last_status_code ?? x.last_error ?? '—'}</td>
                    <td className="small">{formatRelative(x.created_at, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        )
      }
    </Resource>
  );
}

/** Signed HTTPS callbacks (G25); the Webhooks tab of Settings › Developers. */
export function WebhooksPanel() {
  const hooks = useApi('admin:webhooks', (signal) => rd.admin.webhooks(signal));
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const action = useAction();

  const test = async (id: string) => {
    if (await action.run(() => rd.admin.testWebhook(id))) setTested(id);
  };
  const remove = async (id: string) => {
    if (await action.run(() => rd.admin.deleteWebhook(id))) hooks.mutate((prev) => prev?.filter((h) => h.id !== id));
  };

  return (
    <>
      <Banner tag={t('cfg.hook.noteTag')}>
        {t('cfg.hook.noteBefore')} <span className="mono">x-rd-signature: t=…,v1=HMAC-SHA256(secret, &quot;t.body&quot;)</span>{' '}
        {t('cfg.hook.noteAfter')}
      </Banner>
      {tested ? (
        <Banner role="status" title={t('cfg.hook.testQueued')}>
          {t('cfg.hook.testBody')}
        </Banner>
      ) : null}
      <ActionError error={action.error} />
      <Card
        title={t('cfg.hook.endpoints')}
        subtitle={t('cfg.hook.endpointsSubtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('cfg.hook.new')}
          </Button>
        }
      >
        <Resource {...hooks} label={t('cfg.hook.loading')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('cfg.hook.none')}>{t('cfg.hook.noneBody')}</Empty>
            ) : (
              <div className={s.list}>
                {list.map((h) => (
                  <details
                    key={h.id}
                    className={s.item}
                    open={open === h.id}
                    onToggle={(e) => {
                      if (e.currentTarget.open) setOpen(h.id);
                      else if (open === h.id) setOpen(null);
                    }}
                  >
                    <summary>
                      <span className={s.summaryName}>
                        <span className="mono">{h.url}</span>
                        {h.description ? <span className="small muted"> · {h.description}</span> : null}
                      </span>
                      <span className={s.chips}>
                        {h.events.map((e) => (
                          <Badge key={e}>{eventLabel(e)}</Badge>
                        ))}
                      </span>
                    </summary>
                    <div className={s.detail}>
                      <div className={s.inlineForm}>
                        <Button size="sm" onClick={() => test(h.id)} disabled={action.busy}>
                          {t('cfg.hook.test')}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => remove(h.id)} disabled={action.busy}>
                          {t('cfg.hook.delete')}
                        </Button>
                      </div>
                      {open === h.id ? <Deliveries key={tested ?? 'x'} id={h.id} /> : null}
                    </div>
                  </details>
                ))}
              </div>
            )
          }
        </Resource>
      </Card>
      <CreateDialog open={creating} onClose={() => setCreating(false)} onCreated={hooks.reload} />
    </>
  );
}
