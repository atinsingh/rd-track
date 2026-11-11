'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ORG_ROLES, type OrgRole, type UserDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { formGridClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t } from '@/lib/i18n';
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
  roleLabel: (r: OrgRole) => string;
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
    <Dialog open onClose={onClose} title={t('mgr.edit.title', { name: user.display_name })} eyebrow={t('mgr.users.eyebrow')} description={user.email}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={formGridClass}>
          <TextField
            label={t('profile.name')}
            value={name}
            maxLength={200}
            required
            onChange={(e) => setName(e.target.value)}
            error={name.trim() ? null : t('mgr.edit.enterName')}
          />
          <SelectField
            label={t('mgr.users.role')}
            value={role}
            disabled={isSelf}
            hint={isSelf ? t('mgr.edit.ownRole') : undefined}
            onChange={(e) => setRole(e.target.value as OrgRole)}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('date.timeZone')} value={tz} hint={t('mgr.edit.tzHint')} onChange={(e) => setTz(e.target.value)}>
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
              ? t('mgr.edit.finance')
              : role === 'org_admin'
                ? t('mgr.edit.admin')
                : role === 'auditor'
                  ? t('mgr.edit.auditor')
                  : t('mgr.edit.employee')}{' '}
            {t('mgr.edit.audited')}
          </p>
        ) : null}
        <ActionError error={action.error} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!changed || !name.trim() || action.busy}>
            {action.busy ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
