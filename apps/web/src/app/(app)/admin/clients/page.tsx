'use client';

import { useState, type FormEvent } from 'react';
import type { ClientDTO, ProjectDTO } from '@rd/contracts';
import { ClientPortalAccess } from '@/components/money/ClientPortalAccess';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, formActionsClass, formGridClass } from '@/components/ui/Layout';
import { rd, type ClientBody } from '@/lib/api';
import { useMe } from '@/lib/me';
import { CURRENCIES } from '@/lib/money';
import { useAction, useApi } from '@/lib/useApi';
import { t, tPlural } from '@/lib/i18n';
import { MoneyGate } from '../MoneyGate';
import s from '../admin.module.css';
import m from '../money.module.css';

function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = CURRENCIES.includes(value as (typeof CURRENCIES)[number]) ? CURRENCIES : [value, ...CURRENCIES];
  return (
    <SelectField label={t('money.rates.currency')} value={value} onChange={(e) => onChange(e.target.value)} hint={t('money.clients.currencyHint')}>
      {options.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </SelectField>
  );
}

function ClientForm({
  initial,
  submitLabel,
  onSubmit,
  busy,
}: {
  initial?: ClientDTO;
  submitLabel: string;
  onSubmit: (body: ClientBody) => Promise<boolean>;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.contact_email ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? 'USD');
  const [address, setAddress] = useState(initial?.address ?? '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onSubmit({ name: name.trim(), contact_email: email.trim() || null, currency, address: address.trim() || null });
    if (ok && !initial) {
      setName('');
      setEmail('');
      setAddress('');
    }
  };
  return (
    <form onSubmit={submit} className={m.stack}>
      <div className={formGridClass}>
        <TextField label={t('money.clients.name')} value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />
        <TextField label={t('money.clients.email')} type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        <CurrencySelect value={currency} onChange={setCurrency} />
      </div>
      <TextArea label={t('money.clients.address')} rows={3} value={address} maxLength={2000} onChange={(e) => setAddress(e.target.value)} />
      <div className={formActionsClass}>
        <Button type="submit" variant={initial ? 'secondary' : 'primary'} disabled={!name.trim() || busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ClientItem({ client, projects, onChanged }: { client: ClientDTO; projects: ProjectDTO[]; onChanged: () => void }) {
  const action = useAction();
  const { timezone } = useMe();
  // Contacts load only when the client is opened, not for every client on the page.
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const mine = new Set(client.projects.map((p) => p.id));
  const assignable = projects.filter((p) => !mine.has(p.id) && p.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  const update = async (body: Partial<ClientBody>) => {
    const r = await action.run(() => rd.money.updateClient(client.id, body));
    if (r) onChanged();
    return !!r;
  };
  const assign = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId) return;
    if (await action.run(() => rd.money.setProjectClient(projectId, client.id))) {
      setProjectId('');
      onChanged();
    }
  };
  const unassign = async (id: string) => {
    if (await action.run(() => rd.money.setProjectClient(id, null))) onChanged();
  };
  return (
    <li className={s.item}>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className={s.summaryName}>
            {client.name} {client.archived ? <Badge>{t('money.clients.archived')}</Badge> : null}
          </span>
          <span className="small muted">
            {client.currency} · {tPlural(client.projects.length, 'money.clients.projects.one', 'money.clients.projects.other')}
            {client.contact_email ? ` · ${client.contact_email}` : ''}
          </span>
        </summary>
        <div className={s.detail}>
          <div className={m.stack}>
            <span className="eyebrow">{t('money.clients.projectsOf', { name: client.name })}</span>
            {client.projects.length === 0 ? (
              <p className="secondary">{t('money.clients.noProjects')}</p>
            ) : (
              <ul className={s.members}>
                {client.projects.map((p) => (
                  <li key={p.id} className={s.member}>
                    <span>{p.name}</span>
                    <Button size="sm" variant="quiet" onClick={() => unassign(p.id)} disabled={action.busy} aria-label={t('money.clients.removeAria', { project: p.name, client: client.name })}>
                      {t('money.clients.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form className={s.inlineForm} onSubmit={assign}>
              <SelectField label={t('money.clients.addProject')} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t('money.clients.chooseProject')}</option>
                {assignable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
              <Button type="submit" disabled={!projectId || action.busy}>
                {t('money.clients.add')}
              </Button>
            </form>
            <p className="small muted">{t('money.clients.oneClient')}</p>
          </div>
          {open ? <ClientPortalAccess client={client} tz={timezone} onChanged={onChanged} /> : null}
          <ClientForm initial={client} submitLabel={t('money.clients.save')} busy={action.busy} onSubmit={update} />
          <div>
            <Button size="sm" variant="quiet" onClick={() => update({ archived: !client.archived })} disabled={action.busy}>
              {client.archived ? t('money.clients.restore') : t('money.clients.archive')}
            </Button>
          </div>
          <ActionError error={action.error} />
        </div>
      </details>
    </li>
  );
}

function ClientsContent() {
  const clients = useApi('money:clients', (signal) => rd.money.clients(signal));
  const projects = useApi('admin:projects', (signal) => rd.admin.projects(signal));
  const create = useAction();
  const refresh = () => {
    clients.reload();
    projects.reload();
  };
  return (
    <>
      <PageHeader
        eyebrow={t('money.gate.eyebrow')}
        title={t('money.clients.title')}
        description={t('money.clients.description')}
      />
      <Card title={t('money.clients.new')}>
        <ClientForm
          submitLabel={t('money.clients.create')}
          busy={create.busy}
          onSubmit={async (body) => {
            const r = await create.run(() => rd.money.createClient(body));
            if (r) clients.mutate((prev) => [...(prev ?? []), r]);
            return !!r;
          }}
        />
        <ActionError error={create.error} />
      </Card>
      <Card title={t('money.clients.title')}>
        <Resource {...clients} label={t('money.clients.loading')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('money.clients.empty')}>{t('money.clients.emptyBody')}</Empty>
            ) : (
              <ul className={s.list}>
                {[...list]
                  .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
                  .map((c) => (
                    <ClientItem key={c.id} client={c} projects={projects.data ?? []} onChanged={refresh} />
                  ))}
              </ul>
            )
          }
        </Resource>
      </Card>
    </>
  );
}

export default function ClientsPage() {
  return (
    <MoneyGate title={t('money.clients.title')}>
      <ClientsContent />
    </MoneyGate>
  );
}
