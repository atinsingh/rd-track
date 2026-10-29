'use client';

import { useState, type FormEvent } from 'react';
import type { ClientContactDTO, ClientDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, TextField } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Layout';
import { clientAccess } from '@/lib/portal';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';

const STATUS: Record<ClientContactDTO['status'], string> = { invited: 'Invited', active: 'Can sign in', revoked: 'No access' };

/**
 * Who at a client can sign in to the read-only client portal (Stage 4 F9), and whether
 * they see who worked on their projects. Contacts are not users and hold no seat.
 */
export function ClientPortalAccess({ client, tz, onChanged }: { client: ClientDTO; tz: string; onChanged: () => void }) {
  const contacts = useApi(`money:client-contacts|${client.id}`, (signal) => clientAccess.contacts(client.id, signal));
  const action = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setSent(null);
    const r = await action.run(() => clientAccess.invite(client.id, email.trim(), name.trim()));
    if (!r) return;
    setSent(`Invite sent to ${r.email}.`);
    setEmail('');
    setName('');
    contacts.reload();
  };
  const sendLink = async (c: ClientContactDTO) => {
    setSent(null);
    if (await action.run(() => clientAccess.sendLink(c.id))) setSent(`A new sign-in link went to ${c.email}.`);
  };
  const revoke = async (c: ClientContactDTO) => {
    if (await action.run(() => clientAccess.revoke(c.id))) contacts.reload();
  };
  const showPeople = async (on: boolean) => {
    if (await action.run(() => clientAccess.setShowPeople(client.id, on))) onChanged();
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <span className="eyebrow">Client portal</span>
      <p className="small secondary">
        People at {client.name} can sign in to a read-only page with the hours on their projects, budgets and issued invoices. They never see
        activity, apps or screenshots, and they don&apos;t use a seat.
      </p>
      <Checkbox
        label="Show who worked on their projects"
        hint="Names and hours each. Every time a contact sees them, it's in that person's “Who viewed your data”. Off: totals per project only."
        checked={client.portal_show_people}
        disabled={action.busy}
        onChange={(e) => void showPeople(e.target.checked)}
      />
      <Resource {...contacts} label="Loading contacts">
        {(list) =>
          list.length === 0 ? (
            <Empty title="Nobody has access yet" />
          ) : (
            <ul className="stack" style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
              {list.map((c) => (
                <li key={c.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>
                    <strong>{c.display_name}</strong> <span className="small muted">{c.email}</span>{' '}
                    <Badge tone={c.status === 'active' ? 'solid' : 'outline'}>{STATUS[c.status]}</Badge>
                    {c.last_sign_in_at ? <span className="small muted"> · last signed in {formatDateTime(c.last_sign_in_at, tz)}</span> : null}
                  </span>
                  {c.status !== 'revoked' ? (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <Button size="sm" variant="quiet" onClick={() => void sendLink(c)} disabled={action.busy}>
                        {c.status === 'invited' ? 'Send the invite again' : 'Send a new sign-in link'}
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => void revoke(c)} disabled={action.busy}>
                        Remove access
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </Resource>
      <form onSubmit={invite} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <TextField label="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <TextField label="Email" type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" disabled={!name.trim() || !email.trim() || action.busy || client.archived}>
          Invite to the portal
        </Button>
      </form>
      {sent ? <p role="status" className="small">{sent}</p> : null}
      <ActionError error={action.error} />
    </div>
  );
}
