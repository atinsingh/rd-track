'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { ORG_ROLES, createUserRequest, type OrgRole, type UserDTO } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, tableClass } from '@/components/ui/Layout';
import { rd, type ApiError } from '@/lib/api';
import { byName, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { timeZoneOptions } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

const ROLE_LABEL: Record<OrgRole, string> = {
  employee: 'Employee',
  org_admin: 'Org admin',
  auditor: 'Auditor',
  super_admin: 'Super admin',
};

function SeatError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  if (error.code === 'seat_limit_reached' || error.code === 'plan_upgrade_required') {
    return (
      <Banner
        tone="warn"
        role="alert"
        title={error.code === 'seat_limit_reached' ? 'No seat available' : 'Your plan needs an upgrade'}
        actions={<Link href="/admin/billing">Open billing →</Link>}
      >
        {error.code === 'seat_limit_reached'
          ? 'Every licensed seat and the overage allowance are in use. Add seats, or turn tracking off for someone who no longer needs it.'
          : 'The Free plan covers up to 2 people who track time. Move to Standard or Pro to add more.'}
      </Banner>
    );
  }
  return <ActionError error={error} />;
}

function CreateUserDialog({ open, onClose, onCreated, defaultTz }: { open: boolean; onClose: () => void; onCreated: (u: UserDTO) => void; defaultTz: string }) {
  const [form, setForm] = useState({ email: '', display_name: '', org_role: 'employee' as OrgRole, timezone: defaultTz, tracking_enabled: true, password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ user: UserDTO; initial_password?: string } | null>(null);
  const action = useAction();
  const zones = useMemo(() => timeZoneOptions(defaultTz), [defaultTz]);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const close = () => {
    setCreated(null);
    setErrors({});
    action.reset();
    setForm({ email: '', display_name: '', org_role: 'employee', timezone: defaultTz, tracking_enabled: true, password: '' });
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...form, email: form.email.trim(), display_name: form.display_name.trim(), password: form.password || undefined };
    const parsed = createUserRequest.safeParse(body);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    const res = await action.run(() => rd.admin.createUser(body));
    if (res) {
      setCreated(res);
      onCreated(res.user);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? 'Person added' : 'Add a person'}
      eyebrow="Admin · People"
      description={created ? undefined : 'They sign in with their email. People who track time use a billable seat; viewers are free.'}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : undefined
      }
    >
      {created ? (
        <>
          <p>
            <strong>{created.user.display_name}</strong> ({created.user.email}) can now sign in.
          </p>
          {created.initial_password ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--ink)', color: 'var(--ink-text)', padding: 18 }}>
              <span className="label-mono" style={{ color: 'var(--ink-muted)' }}>
                Initial password · shown once
              </span>
              <span className="mono" style={{ fontSize: 20, color: '#fff', wordBreak: 'break-all', userSelect: 'all' }}>
                {created.initial_password}
              </span>
              <span className="small">Share it directly with them. They should change it after first sign-in.</span>
              <div>
                <CopyButton text={created.initial_password} label="Copy password" variant="inverse" />
              </div>
            </div>
          ) : (
            <p className="secondary">They use the password you set.</p>
          )}
        </>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} noValidate>
          <div className={formGridClass}>
            <TextField label="Name" required value={form.display_name} error={errors.display_name} onChange={(e) => set({ display_name: e.target.value })} />
            <TextField label="Work email" type="email" required value={form.email} error={errors.email} onChange={(e) => set({ email: e.target.value })} />
            <SelectField label="Role" value={form.org_role} onChange={(e) => set({ org_role: e.target.value as OrgRole })}>
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </SelectField>
            <SelectField label="Time zone" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </SelectField>
          </div>
          <Checkbox
            label="Tracks their own time"
            hint="Lets them start work sessions. This uses one billable seat."
            checked={form.tracking_enabled}
            onChange={(e) => set({ tracking_enabled: e.target.checked })}
          />
          <TextField
            label="Initial password (optional)"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters. Leave empty to generate one that is shown once."
            value={form.password}
            error={errors.password}
            onChange={(e) => set({ password: e.target.value })}
          />
          {form.org_role === 'org_admin' || form.org_role === 'super_admin' ? (
            <p className="small secondary">Admins must set up two-factor sign-in the first time they sign in.</p>
          ) : null}
          <SeatError error={action.error} />
          <div className={formActionsClass}>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={action.busy}>
              {action.busy ? 'Adding…' : 'Add person'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export default function AdminUsersPage() {
  const { access, timezone, me } = useMe();
  const users = useApi(access.isAdmin ? 'admin:users' : null, (signal) => rd.admin.users(signal));
  const sub = useApi(access.isAdmin ? 'billing:subscription' : null, (signal) => rd.billing.subscription(signal));
  const [adding, setAdding] = useState(false);
  const [deactivating, setDeactivating] = useState<UserDTO | null>(null);
  const toggle = useAction();
  const deact = useAction();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!access.isAdmin) return <NoAccess what="People are managed by org admins." />;

  const replace = (u: UserDTO) => users.mutate((prev) => prev?.map((x) => (x.id === u.id ? u : x)));

  const setTracking = async (u: UserDTO, on: boolean) => {
    setBusyId(u.id);
    const res = await toggle.run(() => rd.admin.updateUser(u.id, { tracking_enabled: on }));
    setBusyId(null);
    if (res !== undefined) {
      replace(res ?? { ...u, tracking_enabled: on });
      sub.reload();
    }
  };

  const confirmDeactivate = async () => {
    if (!deactivating) return;
    const res = await deact.run(() => rd.admin.deactivateUser(deactivating.id));
    if (res) {
      replace({ ...deactivating, status: 'deactivated', tracking_enabled: false });
      setDeactivating(null);
      sub.reload();
    }
  };

  const list = users.data ?? [];
  const active = list.filter((u) => u.status === 'active');
  const tracking = active.filter((u) => u.tracking_enabled).length;

  return (
    <>
      <PageHeader
        eyebrow="Admin · People"
        title="People"
        description={
          users.data
            ? `${plural(active.length, 'active person', 'active people')} · ${tracking} tracking time (billable) · ${active.length - tracking} viewers (free)`
            : 'Everyone in your organization.'
        }
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add a person →
          </Button>
        }
      />
      {sub.data ? (
        <Banner tag="SEATS" actions={<Link href="/admin/billing">Billing →</Link>}>
          <span className="mono">{sub.data.billable_seats}</span> of <span className="mono">{sub.data.seats}</span> licensed seats in use
          {sub.data.seat_ceiling > sub.data.seats ? `, up to ${sub.data.seat_ceiling} with the overage allowance` : ''}. Turning tracking on for
          someone uses a seat; turning it off or deactivating frees it.
        </Banner>
      ) : null}
      <SeatError error={toggle.error} />

      <Card title="Everyone">
        <Resource {...users} label="Loading people">
          {(rows) =>
            rows.length === 0 ? (
              <Empty title="No people yet" />
            ) : (
              <TableBox label="People">
                <table className={tableClass} style={{ minWidth: 860 }}>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Role</th>
                      <th scope="col">Teams</th>
                      <th scope="col">Tracks time</th>
                      <th scope="col">Two-factor</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].sort(byName).map((u) => {
                      const inactive = u.status !== 'active';
                      return (
                        <tr key={u.id}>
                          <td>
                            <span style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontWeight: 600 }}>{u.display_name}</span>
                              <span className="small muted">{u.email}</span>
                            </span>
                          </td>
                          <td>{ROLE_LABEL[u.org_role]}</td>
                          <td className="small">
                            {u.teams.length ? u.teams.map((t) => `${t.name}${t.role === 'manager' ? ' (manager)' : ''}`).join(', ') : '—'}
                          </td>
                          <td>
                            <Button
                              size="sm"
                              variant="quiet"
                              aria-pressed={u.tracking_enabled}
                              aria-label={`Tracks time: ${u.tracking_enabled ? 'on' : 'off'} for ${u.display_name}`}
                              disabled={inactive || busyId === u.id}
                              onClick={() => setTracking(u, !u.tracking_enabled)}
                              title={u.tracking_enabled ? 'Turn off: frees a seat' : 'Turn on: uses a billable seat'}
                            >
                              {busyId === u.id ? 'Saving…' : u.tracking_enabled ? 'On · uses a seat' : 'Off'}
                            </Button>
                          </td>
                          <td>{u.mfa_enabled ? <Badge>On</Badge> : <span className="muted">Off</span>}</td>
                          <td>{inactive ? <Badge>Deactivated</Badge> : <Badge tone="solid">Active</Badge>}</td>
                          <td style={{ textAlign: 'right' }}>
                            {!inactive && u.id !== me.user.id ? (
                              <Button size="sm" variant="danger" onClick={() => setDeactivating(u)}>
                                Deactivate
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>

      <CreateUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        defaultTz={timezone}
        onCreated={(u) => {
          users.mutate((prev) => [...(prev ?? []), u]);
          sub.reload();
        }}
      />
      <Dialog
        open={deactivating !== null}
        onClose={() => {
          setDeactivating(null);
          deact.reset();
        }}
        size="sm"
        title={`Deactivate ${deactivating?.display_name ?? ''}?`}
        description="They can no longer sign in, their devices stop collecting, and their seat is freed. Their records stay under retention."
        footer={
          <>
            <Button onClick={() => setDeactivating(null)}>Cancel</Button>
            <Button variant="primary" onClick={confirmDeactivate} disabled={deact.busy}>
              {deact.busy ? 'Deactivating…' : 'Deactivate'}
            </Button>
          </>
        }
      >
        <ActionError error={deact.error} />
      </Dialog>
    </>
  );
}
