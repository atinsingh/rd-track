'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { ORG_ROLES, createUserRequest, type OrgRole, type UserDTO } from '@rd/contracts';
import { EditUserDialog } from '@/components/people/EditUserDialog';
import { ImportPeopleDialog } from '@/components/people/ImportPeopleDialog';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Segmented, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, formActionsClass, formGridClass, tableClass } from '@/components/ui/Layout';
import { rd, type ApiError } from '@/lib/api';
import { byName } from '@/lib/format';
import { t, tPlural, type MessageKey } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { timeZoneOptions } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from './users.module.css';

const ROLE_KEY: Record<OrgRole, MessageKey> = {
  employee: 'role.employee',
  org_admin: 'role.orgAdmin',
  auditor: 'role.auditor',
  super_admin: 'role.superAdmin',
  finance: 'role.finance',
};
const roleLabel = (r: OrgRole) => t(ROLE_KEY[r]);

function SeatError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  if (error.code === 'seat_limit_reached' || error.code === 'plan_upgrade_required') {
    return (
      <Banner
        tone="warn"
        role="alert"
        title={error.code === 'seat_limit_reached' ? t('mgr.users.noSeat') : t('mgr.users.upgrade')}
        actions={<Link href="/admin/billing">{t('licence.openBilling')}</Link>}
      >
        {error.code === 'seat_limit_reached' ? t('mgr.users.noSeatBody') : t('mgr.users.upgradeBody')}
      </Banner>
    );
  }
  return <ActionError error={error} />;
}

function CreateUserDialog({ open, onClose, onCreated, defaultTz }: { open: boolean; onClose: () => void; onCreated: (u: UserDTO) => void; defaultTz: string }) {
  const [form, setForm] = useState({ email: '', display_name: '', org_role: 'employee' as OrgRole, timezone: defaultTz, tracking_enabled: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<UserDTO | null>(null);
  const action = useAction();
  const zones = useMemo(() => timeZoneOptions(defaultTz), [defaultTz]);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const close = () => {
    setCreated(null);
    setErrors({});
    action.reset();
    setForm({ email: '', display_name: '', org_role: 'employee', timezone: defaultTz, tracking_enabled: true });
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...form, email: form.email.trim(), display_name: form.display_name.trim() };
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
      setCreated(res.user);
      onCreated(res.user);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? t('mgr.users.inviteSent') : t('mgr.users.invite')}
      eyebrow={t('mgr.users.eyebrow')}
      description={created ? undefined : t('mgr.users.inviteDesc')}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            {t('security.done')}
          </Button>
        ) : undefined
      }
    >
      {created ? (
        <>
          <p>
            {t('mgr.users.emailedPre')}
            <strong>{created.display_name}</strong>
            {t('mgr.users.emailedPost', { email: created.email })}
          </p>
          <p className="secondary small">{t('mgr.users.didntArrive')}</p>
        </>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} noValidate>
          <div className={formGridClass}>
            <TextField label={t('profile.name')} required value={form.display_name} error={errors.display_name} onChange={(e) => set({ display_name: e.target.value })} />
            <TextField label={t('login.email')} type="email" required value={form.email} error={errors.email} onChange={(e) => set({ email: e.target.value })} />
            <SelectField label={t('mgr.users.role')} value={form.org_role} onChange={(e) => set({ org_role: e.target.value as OrgRole })}>
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </SelectField>
            <SelectField label={t('date.timeZone')} value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </SelectField>
          </div>
          <Checkbox
            label={t('mgr.users.tracksOwn')}
            hint={t('mgr.users.tracksOwnHint')}
            checked={form.tracking_enabled}
            onChange={(e) => set({ tracking_enabled: e.target.checked })}
          />
          {form.org_role === 'finance' ? (
            <p className="small secondary">{t('mgr.users.financeNote')}</p>
          ) : null}
          {form.org_role === 'org_admin' || form.org_role === 'super_admin' || form.org_role === 'finance' ? (
            <p className="small secondary">{t('mgr.users.mfaNote')}</p>
          ) : null}
          <SeatError error={action.error} />
          <div className={formActionsClass}>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={action.busy}>
              {action.busy ? t('mgr.ap.sending') : t('mgr.users.sendInvite')}
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
  const rowAction = useAction();
  const [rowNote, setRowNote] = useState<string | null>(null);
  const [resettingMfa, setResettingMfa] = useState<UserDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserDTO | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'active' | 'invited' | 'deactivated' | 'all'>('active');

  if (!access.isAdmin) return <NoAccess what={t('mgr.users.noAccess')} />;

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

  const reactivate = async (u: UserDTO) => {
    setRowNote(null);
    setBusyId(u.id);
    const r = await rowAction.run(() => rd.admin.reactivateUser(u.id));
    setBusyId(null);
    if (r) {
      replace(r);
      sub.reload();
      setRowNote(t('mgr.users.reactivated', { name: u.display_name }));
    }
  };

  const resend = async (u: UserDTO) => {
    setRowNote(null);
    setBusyId(u.id);
    const ok = await rowAction.run(() => rd.admin.resendInvite(u.id));
    setBusyId(null);
    if (ok) {
      setRowNote(t('mgr.users.resent', { email: u.email }));
      replace({ ...u, invited_at: new Date().toISOString() });
    }
  };
  const confirmResetMfa = async () => {
    if (!resettingMfa) return;
    const u = resettingMfa;
    const ok = await rowAction.run(() => rd.admin.resetMfa(u.id));
    setResettingMfa(null);
    if (ok) {
      setRowNote(t('mgr.users.mfaReset', { name: u.display_name }));
      replace({ ...u, mfa_enabled: false });
    }
  };

  const list = users.data ?? [];
  const stateOf = (u: UserDTO) => (u.status !== 'active' ? 'deactivated' : u.invite_pending ? 'invited' : 'active');
  const needle = search.trim().toLowerCase();
  const matches = (u: UserDTO) =>
    (show === 'all' || stateOf(u) === show) &&
    (!needle || u.display_name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle) || u.teams.some((tm) => tm.name.toLowerCase().includes(needle)));
  const countOf = (k: 'active' | 'invited' | 'deactivated') => list.filter((u) => stateOf(u) === k).length;
  const active = list.filter((u) => u.status === 'active');
  const tracking = active.filter((u) => u.tracking_enabled).length;

  return (
    <>
      <PageHeader
        eyebrow={t('mgr.users.eyebrow')}
        title={t('mgr.users.title')}
        description={
          users.data
            ? tPlural(active.length, 'mgr.users.summaryOne', 'mgr.users.summaryOther', { tracking, viewers: active.length - tracking })
            : t('mgr.users.everyoneDesc')
        }
        actions={
          <>
            <Button onClick={() => setImporting(true)}>{t('mgr.users.importCsv')}</Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t('mgr.users.inviteArrow')}
            </Button>
          </>
        }
      />
      {sub.data ? (
        <Banner tag={t('mgr.users.seatsTag')} actions={<Link href="/admin/billing">{t('mgr.users.billing')}</Link>}>
          <span className="mono">{sub.data.billable_seats}</span>
          {t('mgr.users.seatsPre')}
          <span className="mono">{sub.data.seats}</span>
          {t('mgr.users.seatsInUse')}
          {sub.data.seat_ceiling > sub.data.seats ? t('mgr.users.seatsCeiling', { n: sub.data.seat_ceiling }) : ''}
          {t('mgr.users.seatsPost')}
        </Banner>
      ) : null}
      <SeatError error={toggle.error} />
      <ActionError error={rowAction.error} />
      {rowNote ? (
        <Banner role="status" title={rowNote} actions={<Button size="sm" variant="quiet" onClick={() => setRowNote(null)}>{t('common.dismiss')}</Button>} />
      ) : null}

      <Card
        title={t('mgr.users.everyone')}
        actions={
          <Segmented<typeof show>
            legend={t('mgr.users.show')}
            name="people-show"
            value={show}
            onChange={setShow}
            options={[
              { value: 'active', label: t('mgr.users.showActive', { n: countOf('active') }) },
              { value: 'invited', label: t('mgr.users.showInvited', { n: countOf('invited') }) },
              { value: 'deactivated', label: t('mgr.users.showDeactivated', { n: countOf('deactivated') }) },
              { value: 'all', label: t('mgr.tab.all') },
            ]}
          />
        }
      >
        <TextField label={t('mgr.users.search')} placeholder={t('mgr.users.searchPh')} value={search} onChange={(e) => setSearch(e.target.value)} type="search" />
        <Resource {...users} label={t('mgr.users.loading')}>
          {(all) => {
            const rows = all.filter(matches);
            return rows.length === 0 ? (
              <Empty title={all.length === 0 ? t('mgr.users.noPeople') : t('mgr.users.noMatch')} />
            ) : (
              <TableBox label={t('mgr.users.title')}>
                <table className={tableClass} style={{ minWidth: 860 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('mgr.users.colPerson')}</th>
                      <th scope="col">{t('mgr.users.role')}</th>
                      <th scope="col">{t('mgr.users.colTeams')}</th>
                      <th scope="col">{t('mgr.users.colTracks')}</th>
                      <th scope="col">{t('mgr.users.colMfa')}</th>
                      <th scope="col">{t('mgr.users.colStatus')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('mgr.users.colActions')}</span>
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
                          <td>{roleLabel(u.org_role)}</td>
                          <td className="small">
                            {u.teams.length ? u.teams.map((tm) => `${tm.name}${tm.role === 'manager' ? t('mgr.users.asManager') : ''}`).join(', ') : '—'}
                          </td>
                          <td>
                            <Button
                              size="sm"
                              variant="quiet"
                              aria-pressed={u.tracking_enabled}
                              aria-label={t('mgr.users.tracksAria', { state: u.tracking_enabled ? t('mgr.users.on') : t('mgr.users.off'), name: u.display_name })}
                              disabled={inactive || busyId === u.id}
                              onClick={() => setTracking(u, !u.tracking_enabled)}
                              title={u.tracking_enabled ? t('mgr.users.turnOff') : t('mgr.users.turnOn')}
                            >
                              {busyId === u.id ? t('common.saving') : u.tracking_enabled ? t('mgr.users.onSeat') : t('mgr.users.offBtn')}
                            </Button>
                          </td>
                          <td>{u.mfa_enabled ? <Badge>{t('mgr.users.mfaOn')}</Badge> : <span className="muted">{t('mgr.users.mfaOff')}</span>}</td>
                          <td>
                            {inactive ? (
                              <Badge>{t('mgr.users.badgeDeactivated')}</Badge>
                            ) : u.invite_pending ? (
                              <Badge tone="warn">{t('mgr.users.badgeInvited')}</Badge>
                            ) : (
                              <Badge tone="solid">{t('mgr.users.badgeActive')}</Badge>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span className={s.rowActions}>
                              {inactive ? (
                                <Button size="sm" variant="quiet" disabled={busyId === u.id} onClick={() => void reactivate(u)}>
                                  {busyId === u.id ? t('mgr.users.reactivating') : t('mgr.users.reactivate')}
                                </Button>
                              ) : (
                                <Button size="sm" variant="quiet" onClick={() => setEditing(u)} aria-label={t('mgr.users.editAria', { name: u.display_name })}>
                                  {t('mgr.users.edit')}
                                </Button>
                              )}
                              {!inactive && u.invite_pending ? (
                                <Button size="sm" variant="quiet" disabled={busyId === u.id} onClick={() => void resend(u)}>
                                  {busyId === u.id ? t('mgr.ap.sending') : t('mgr.users.resend')}
                                </Button>
                              ) : null}
                              {!inactive && u.mfa_enabled && u.id !== me.user.id ? (
                                <Button size="sm" variant="quiet" onClick={() => setResettingMfa(u)}>
                                  {t('mgr.users.resetMfa')}
                                </Button>
                              ) : null}
                              {!inactive && u.id !== me.user.id ? (
                                <Button size="sm" variant="danger" onClick={() => setDeactivating(u)}>
                                  {u.invite_pending ? t('mgr.users.cancelInvite') : t('mgr.users.deactivate')}
                                </Button>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableBox>
            );
          }}
        </Resource>
      </Card>

      {editing ? (
        <EditUserDialog user={editing} isSelf={editing.id === me.user.id} roleLabel={roleLabel} onClose={() => setEditing(null)} onSaved={replace} />
      ) : null}
      <ImportPeopleDialog
        open={importing}
        onClose={() => setImporting(false)}
        defaultTz={timezone}
        onDone={() => {
          users.reload();
          sub.reload();
        }}
      />
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
        title={t('mgr.users.deactivateTitle', { name: deactivating?.display_name ?? '' })}
        description={t('mgr.users.deactivateDesc')}
        footer={
          <>
            <Button onClick={() => setDeactivating(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={confirmDeactivate} disabled={deact.busy}>
              {deact.busy ? t('mgr.users.deactivating') : t('mgr.users.deactivate')}
            </Button>
          </>
        }
      >
        <ActionError error={deact.error} />
      </Dialog>
      <Dialog
        open={resettingMfa !== null}
        onClose={() => setResettingMfa(null)}
        size="sm"
        title={t('mgr.users.resetTitle', { name: resettingMfa?.display_name ?? '' })}
        description={t('mgr.users.resetDesc')}
        footer={
          <>
            <Button onClick={() => setResettingMfa(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void confirmResetMfa()} disabled={rowAction.busy}>
              {rowAction.busy ? t('mgr.users.resetting') : t('mgr.users.resetMfa')}
            </Button>
          </>
        }
      />
    </>
  );
}
