'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ORG_ROLES, type OrgRole, type UserDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { formGridClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { timeZoneOptions } from '@/lib/time';
import { useAction } from '@/lib/useApi';

/** Name, role and time zone (G14). Tracking stays a one-click toggle on the row, since it moves a seat. */
export function EditUserDialog({
  user,
  isSelf,
  roleLabel,
  onClose,
  onSaved,
}: {
  user: UserDTO;
  isSelf: boolean;
  roleLabel: Record<OrgRole, string>;
  onClose: () => void;
  onSaved: (u: UserDTO) => void;
}) {
  const [name, setName] = useState(user.display_name);
  const [role, setRole] = useState<OrgRole>(user.org_role);
  const [tz, setTz] = useState(user.timezone);
  const zones = useMemo(() => timeZoneOptions(user.timezone), [user.timezone]);
  const action = useAction();
  const changed = name.trim() !== user.display_name || role !== user.org_role || tz !== user.timezone;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const body = {
      ...(name.trim() !== user.display_name ? { display_name: name.trim() } : {}),
      ...(role !== user.org_role ? { org_role: role } : {}),
      ...(tz !== user.timezone ? { timezone: tz } : {}),
    };
    const r = await action.run(() => rd.admin.updateUser(user.id, body));
    if (r !== undefined) {
      onSaved(r ?? { ...user, display_name: name.trim(), org_role: role, timezone: tz });
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Edit ${user.display_name}`} eyebrow="Admin · People" description={user.email}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={formGridClass}>
          <TextField label="Name" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} error={name.trim() ? null : 'Enter a name'} />
          <SelectField
            label="Role"
            value={role}
            disabled={isSelf}
            hint={isSelf ? 'Ask another admin to change your own role' : undefined}
            onChange={(e) => setRole(e.target.value as OrgRole)}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </SelectField>
          <SelectField label="Time zone" value={tz} hint="Their days, deadlines and reminders follow it" onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </SelectField>
        </div>
        {role !== user.org_role ? (
          <p className="small secondary">
            {role === 'finance'
              ? 'Finance runs rates, invoices, budgets and payroll; never activity, apps or screenshots.'
              : role === 'org_admin'
                ? 'Admins manage people, policies and devices, and must use two-factor sign-in.'
                : role === 'auditor'
                  ? 'Auditors read the audit log only.'
                  : 'They keep only their own pages and anything their team role gives them.'}{' '}
            The change is recorded in the audit log.
          </p>
        ) : null}
        <ActionError error={action.error} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!changed || !name.trim() || action.busy}>
            {action.busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
