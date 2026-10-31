'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { PLAN_IDS, type PlanId, type PlatformTenantDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader, TableBox, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { platform } from '@/lib/platform';
import { formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';

type Show = 'all' | 'trialing' | 'attention' | 'active' | 'ended';
const STATUS_LABEL: Record<PlatformTenantDTO['status'], string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Past due',
  grace: 'Grace',
  inactive: 'Inactive',
  canceled: 'Canceled',
};
const bucket = (t: PlatformTenantDTO): Exclude<Show, 'all'> =>
  t.status === 'trialing' ? 'trialing' : t.status === 'past_due' || t.status === 'grace' ? 'attention' : t.status === 'active' ? 'active' : 'ended';

function NewTenant({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: '', slug: '', admin_email: '', admin_name: '', plan: '' as '' | PlanId, seats: '0' });
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const close = () => {
    setDone(null);
    action.reset();
    setF({ name: '', slug: '', admin_email: '', admin_name: '', plan: '', seats: '0' });
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() =>
      platform.createTenant({
        name: f.name.trim(),
        slug: f.slug.trim(),
        admin_email: f.admin_email.trim(),
        admin_name: f.admin_name.trim(),
        ...(f.plan ? { plan: f.plan, seats: Number(f.seats) || 0 } : {}),
      }),
    );
    if (r) {
      setDone(f.admin_email.trim());
      onCreated();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={done ? 'Organization created' : 'New organization'}
      eyebrow="Platform"
      description={done ? undefined : 'Its first admin gets an invite and chooses their own password; you never see it.'}
      footer={done ? <Button variant="primary" onClick={close}>Done</Button> : undefined}
    >
      {done ? (
        <p>We invited {done}. The organization is ready when they accept.</p>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className={formGridClass}>
            <TextField label="Organization name" required value={f.name} onChange={(e) => set({ name: e.target.value })} />
            <TextField label="Slug" hint="Lowercase letters, numbers and dashes" required value={f.slug} onChange={(e) => set({ slug: e.target.value })} />
            <TextField label="First admin's name" required value={f.admin_name} onChange={(e) => set({ admin_name: e.target.value })} />
            <TextField label="First admin's email" type="email" required value={f.admin_email} onChange={(e) => set({ admin_email: e.target.value })} />
            <SelectField label="Start on" value={f.plan} onChange={(e) => set({ plan: e.target.value as '' | PlanId })}>
              <option value="">14-day Pro trial</option>
              {PLAN_IDS.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)} plan
                </option>
              ))}
            </SelectField>
            {f.plan ? <TextField label="Seats" type="number" min={0} value={f.seats} onChange={(e) => set({ seats: e.target.value })} /> : null}
          </div>
          <ActionError error={action.error} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={action.busy || !f.name.trim() || !f.slug.trim() || !f.admin_email.trim() || !f.admin_name.trim()}>
              {action.busy ? 'Creating…' : 'Create and invite'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Operator home (§4): organizations by state, with health counts only. */
export default function Tenants() {
  const tenants = useApi('platform:tenants', (signal) => platform.tenants(signal));
  const [show, setShow] = useState<Show>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const all = tenants.data ?? [];
  const count = (k: Exclude<Show, 'all'>) => all.filter((t) => bucket(t) === k).length;
  const tz = 'UTC';
  return (
    <>
      <PageHeader
        eyebrow="Platform · Organizations"
        title="Organizations"
        description="Plans, seats and health for every organization. Times are UTC."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            New organization →
          </Button>
        }
      />
      <Card
        title="All organizations"
        actions={
          <Segmented<Show>
            legend="Show"
            name="tenant-show"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: `All ${all.length}` },
              { value: 'trialing', label: `Trial ${count('trialing')}` },
              { value: 'attention', label: `Past due or grace ${count('attention')}` },
              { value: 'active', label: `Active ${count('active')}` },
              { value: 'ended', label: `Inactive ${count('ended')}` },
            ]}
          />
        }
      >
        <TextField label="Search" type="search" placeholder="Name or slug" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Resource {...tenants} label="Loading organizations">
          {(list) => {
            const needle = search.trim().toLowerCase();
            const rows = list.filter((t) => (show === 'all' || bucket(t) === show) && (!needle || t.name.toLowerCase().includes(needle) || t.slug.includes(needle)));
            return rows.length === 0 ? (
              <Empty title="No organizations match" />
            ) : (
              <TableBox label="Organizations">
                <table className={tableClass} style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th scope="col">Organization</th>
                      <th scope="col">Plan</th>
                      <th scope="col">State</th>
                      <th scope="col" className={numClass}>
                        Seats used
                      </th>
                      <th scope="col" className={numClass}>
                        People
                      </th>
                      <th scope="col" className={numClass}>
                        Computers
                      </th>
                      <th scope="col">Last sync</th>
                      <th scope="col">Support</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id}>
                        <th scope="row">
                          <Link href={`/platform/tenants/${t.id}`}>{t.name}</Link>
                          <span className="small muted"> · {t.slug}</span>
                        </th>
                        <td>{t.plan}</td>
                        <td>
                          <Badge tone={bucket(t) === 'attention' ? 'warn' : bucket(t) === 'active' ? 'solid' : 'outline'}>{STATUS_LABEL[t.status]}</Badge>
                          {t.status === 'trialing' && t.trial_ends_at ? <span className="small muted"> ends {formatRelative(t.trial_ends_at, tz)}</span> : null}
                          {t.deletion_scheduled_at ? <span className="small"> · closing {formatRelative(t.deletion_scheduled_at, tz)}</span> : null}
                        </td>
                        <td className={numClass}>
                          {t.billable_seats} / {t.seats}
                        </td>
                        <td className={numClass}>{t.people}</td>
                        <td className={numClass}>{t.devices}</td>
                        <td className="small">{t.last_sync_at ? formatRelative(t.last_sync_at, tz) : 'Never'}</td>
                        <td className="small">{t.support_active ? <Badge tone="warn">Access open</Badge> : t.support_pending ? 'Asked' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            );
          }}
        </Resource>
      </Card>
      <NewTenant open={adding} onClose={() => setAdding(false)} onCreated={tenants.reload} />
    </>
  );
}
