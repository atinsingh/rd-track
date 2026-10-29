'use client';

import { useState, type FormEvent } from 'react';
import type { ClientDTO, ProjectDTO } from '@rd/contracts';
import { ClientPortalAccess } from '@/components/money/ClientPortalAccess';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, formActionsClass, formGridClass } from '@/components/ui/Layout';
import { rd, type ClientBody } from '@/lib/api';
import { plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { CURRENCIES } from '@/lib/money';
import { useAction, useApi } from '@/lib/useApi';
import { MoneyGate } from '../MoneyGate';
import s from '../admin.module.css';
import m from '../money.module.css';

function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = CURRENCIES.includes(value as (typeof CURRENCIES)[number]) ? CURRENCIES : [value, ...CURRENCIES];
  return (
    <SelectField label="Currency" value={value} onChange={(e) => onChange(e.target.value)} hint="Invoices for this client use it">
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
        <TextField label="Client name" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />
        <TextField label="Billing contact email (optional)" type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        <CurrencySelect value={currency} onChange={setCurrency} />
      </div>
      <TextArea label="Billing address (optional)" rows={3} value={address} maxLength={2000} onChange={(e) => setAddress(e.target.value)} />
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
            {client.name} {client.archived ? <Badge>Archived</Badge> : null}
          </span>
          <span className="small muted">
            {client.currency} · {plural(client.projects.length, 'project')}
            {client.contact_email ? ` · ${client.contact_email}` : ''}
          </span>
        </summary>
        <div className={s.detail}>
          <div className={m.stack}>
            <span className="eyebrow">Projects billed to {client.name}</span>
            {client.projects.length === 0 ? (
              <p className="secondary">No projects yet. Time on a client&apos;s projects is what its invoices are built from.</p>
            ) : (
              <ul className={s.members}>
                {client.projects.map((p) => (
                  <li key={p.id} className={s.member}>
                    <span>{p.name}</span>
                    <Button size="sm" variant="quiet" onClick={() => unassign(p.id)} disabled={action.busy} aria-label={`Remove ${p.name} from ${client.name}`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form className={s.inlineForm} onSubmit={assign}>
              <SelectField label="Add a project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Choose a project…</option>
                {assignable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
              <Button type="submit" disabled={!projectId || action.busy}>
                Add
              </Button>
            </form>
            <p className="small muted">A project belongs to one client at a time. Moving it changes future invoices only; issued invoices stay as they are.</p>
          </div>
          {open ? <ClientPortalAccess client={client} tz={timezone} onChanged={onChanged} /> : null}
          <ClientForm initial={client} submitLabel="Save changes" busy={action.busy} onSubmit={update} />
          <div>
            <Button size="sm" variant="quiet" onClick={() => update({ archived: !client.archived })} disabled={action.busy}>
              {client.archived ? 'Restore client' : 'Archive client'}
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
        eyebrow="Admin · Money"
        title="Clients"
        description="Who you bill. Assign projects to a client, then build invoices from the time recorded on them."
      />
      <Card title="New client">
        <ClientForm
          submitLabel="Create client"
          busy={create.busy}
          onSubmit={async (body) => {
            const r = await create.run(() => rd.money.createClient(body));
            if (r) clients.mutate((prev) => [...(prev ?? []), r]);
            return !!r;
          }}
        />
        <ActionError error={create.error} />
      </Card>
      <Card title="Clients">
        <Resource {...clients} label="Loading clients">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No clients yet">Create one above, then assign its projects.</Empty>
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
    <MoneyGate title="Clients">
      <ClientsContent />
    </MoneyGate>
  );
}
