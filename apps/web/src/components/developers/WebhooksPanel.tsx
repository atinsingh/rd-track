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
import { useMe } from '@/lib/me';
import { formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from '@/app/(app)/admin/admin.module.css';

const EVENT_LABELS: Record<WebhookEventType, string> = {
  'session.started': 'Session started',
  'session.stopped': 'Session stopped',
  'time_correction.submitted': 'Time correction submitted',
  'time_correction.approved': 'Time correction approved',
  'time_correction.rejected': 'Time correction sent back',
  'timesheet.submitted': 'Timesheet submitted',
  'timesheet.approved': 'Timesheet approved',
  'timesheet.rejected': 'Timesheet sent back',
  'time_off.requested': 'Time off requested',
  'time_off.approved': 'Time off approved',
  'time_off.rejected': 'Time off declined',
  'user.invited': 'Person invited',
  'user.deactivated': 'Person deactivated',
  'device.revoked': 'Computer removed',
  'export.ready': 'Export ready',
};

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
      eyebrow="Webhook"
      title={created ? 'Signing secret' : 'New webhook'}
      description={
        created
          ? 'Use this secret to verify the x-rd-signature header. It is shown only once.'
          : 'We POST a small JSON payload — ids and times only — to this address when the selected events happen.'
      }
      footer={
        created ? (
          <>
            <CopyButton text={created.signing_secret ?? ''} label="Copy secret" />
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create} disabled={action.busy || events.length === 0 || !url.startsWith('https://')}>
              {action.busy ? 'Creating…' : 'Create webhook'}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className={s.secret} aria-label="Signing secret">
          {created.signing_secret}
        </div>
      ) : (
        <>
          <TextField label="Endpoint URL" type="url" value={url} onChange={(e) => setUrl(e.target.value)} hint="https only, on a public address." />
          <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">Events</legend>
            {WEBHOOK_EVENTS.map((e) => (
              <Checkbox key={e} label={EVENT_LABELS[e]} checked={events.includes(e)} onChange={(ev) => toggle(e, ev.target.checked)} />
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
    <Resource {...d} label="Loading deliveries">
      {(list) =>
        list.length === 0 ? (
          <p className="small muted">No deliveries yet.</p>
        ) : (
          <TableBox label="Recent deliveries">
            <table className={tableClass} style={{ minWidth: 600 }}>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Status</th>
                  <th scope="col" className={numClass}>
                    Attempts
                  </th>
                  <th scope="col">Last response</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id}>
                    <td className="mono small">{x.event_type}</td>
                    <td>
                      <Badge tone={x.status === 'delivered' ? 'solid' : x.status === 'failed' ? 'warn' : 'outline'}>{x.status}</Badge>
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
      <Banner tag="NOTE">
        Payloads carry ids and timestamps only — never screenshots, app names or activity detail. Each request is signed with{' '}
        <span className="mono">x-rd-signature: t=…,v1=HMAC-SHA256(secret, &quot;t.body&quot;)</span> and retried with backoff for up to
        about a day.
      </Banner>
      {tested ? (
        <Banner role="status" title="Test event queued">
          Open the deliveries below to see the response.
        </Banner>
      ) : null}
      <ActionError error={action.error} />
      <Card
        title="Endpoints"
        subtitle="Signed HTTPS callbacks when sessions start or stop, corrections are approved and exports are ready"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New webhook →
          </Button>
        }
      >
        <Resource {...hooks} label="Loading webhooks">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No webhooks yet">Create one to send events to another system.</Empty>
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
                          <Badge key={e}>{EVENT_LABELS[e]}</Badge>
                        ))}
                      </span>
                    </summary>
                    <div className={s.detail}>
                      <div className={s.inlineForm}>
                        <Button size="sm" onClick={() => test(h.id)} disabled={action.busy}>
                          Send test event
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => remove(h.id)} disabled={action.busy}>
                          Delete
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
