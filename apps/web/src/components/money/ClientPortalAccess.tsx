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
import { t } from '@/lib/i18n';

const statusText = (st: ClientContactDTO['status']) => t(`money.portal.status.${st}`);

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
    setSent(t('money.portal.inviteSent', { email: r.email }));
    setEmail('');
    setName('');
    contacts.reload();
  };
  const sendLink = async (c: ClientContactDTO) => {
    setSent(null);
    if (await action.run(() => clientAccess.sendLink(c.id))) setSent(t('money.portal.linkSent', { email: c.email }));
  };
  const revoke = async (c: ClientContactDTO) => {
    if (await action.run(() => clientAccess.revoke(c.id))) contacts.reload();
  };
  const showPeople = async (on: boolean) => {
    if (await action.run(() => clientAccess.setShowPeople(client.id, on))) onChanged();
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <span className="eyebrow">{t('money.portal.eyebrow')}</span>
      <p className="small secondary">{t('money.portal.intro', { client: client.name })}</p>
      <Checkbox
        label={t('money.portal.showPeople')}
        hint={t('money.portal.showPeopleHint')}
        checked={client.portal_show_people}
        disabled={action.busy}
        onChange={(e) => void showPeople(e.target.checked)}
      />
      <Resource {...contacts} label={t('money.portal.loading')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('money.portal.nobody')} />
          ) : (
            <ul className="stack" style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
              {list.map((c) => (
                <li key={c.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>
                    <strong>{c.display_name}</strong> <span className="small muted">{c.email}</span>{' '}
                    <Badge tone={c.status === 'active' ? 'solid' : 'outline'}>{statusText(c.status)}</Badge>
                    {c.last_sign_in_at ? <span className="small muted">{t('money.portal.lastSignIn', { when: formatDateTime(c.last_sign_in_at, tz) })}</span> : null}
                  </span>
                  {c.status !== 'revoked' ? (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <Button size="sm" variant="quiet" onClick={() => void sendLink(c)} disabled={action.busy}>
                        {c.status === 'invited' ? t('money.portal.resendInvite') : t('money.portal.newLink')}
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => void revoke(c)} disabled={action.busy}>
                        {t('money.portal.remove')}
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
        <TextField label={t('money.portal.name')} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <TextField label={t('money.portal.email')} type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" disabled={!name.trim() || !email.trim() || action.busy || client.archived}>
          {t('money.portal.invite')}
        </Button>
      </form>
      {sent ? <p role="status" className="small">{sent}</p> : null}
      <ActionError error={action.error} />
    </div>
  );
}
