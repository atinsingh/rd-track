'use client';

import { useState } from 'react';
import { NOTIFICATION_CATEGORY_LABELS, type NotificationCategory, type NotificationPreference } from '@rd/contracts';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { can, type Access } from '@/lib/nav';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { ProfileCard, SecurityCard } from './AccountCards';
import s from './settings.module.css';

/** Categories that can concern this person; the rest never reach them. */
function relevant(c: NotificationCategory, a: Access): boolean {
  switch (c) {
    case 'approvals':
      return can(a, 'approvals');
    case 'budgets':
      return a.managesProjects || can(a, 'money');
    case 'billing':
      return a.isAdmin;
    default:
      return true;
  }
}

export default function SettingsPage() {
  const { me, access } = useMe();
  const prefs = useApi('me:notification-preferences', (signal) => rd.my.notificationPreferences(signal));
  const save = useAction();
  const [saved, setSaved] = useState<string | null>(null);

  const toggle = async (p: NotificationPreference, channel: 'in_app' | 'email', value: boolean) => {
    const next = { category: p.category, in_app: p.in_app, email: p.email, [channel]: value };
    prefs.mutate((prev) => prev && { items: prev.items.map((x) => (x.category === p.category ? { ...x, ...next } : x)) });
    setSaved(null);
    const r = await save.run(() => rd.my.setNotificationPreferences([next]));
    if (r) {
      prefs.mutate(() => r);
      setSaved(`${NOTIFICATION_CATEGORY_LABELS[p.category].label}: saved`);
    } else prefs.reload();
  };

  return (
    <>
      <PageHeader
        eyebrow="Me · Settings"
        title="Settings"
        description={`Signed in as ${me.user.email}. Your profile, how you sign in, and how Track tells you about things.`}
      />
      <ProfileCard />
      <SecurityCard />
      <Card title="Notifications" subtitle="In-app notices appear under the bell in the menu. Emails carry a link, never your activity.">
        {prefs.error ? <ErrorState error={prefs.error} onRetry={prefs.reload} /> : null}
        {!prefs.data && !prefs.error ? <Loading label="Loading your notification settings" /> : null}
        {prefs.data ? (
          <TableBox label="Notification settings">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">About</th>
                  <th scope="col" className={s.center}>
                    In app
                  </th>
                  <th scope="col" className={s.center}>
                    Email
                  </th>
                </tr>
              </thead>
              <tbody>
                {prefs.data.items
                  .filter((p) => relevant(p.category, access))
                  .map((p) => {
                    const l = NOTIFICATION_CATEGORY_LABELS[p.category];
                    return (
                      <tr key={p.category}>
                        <th scope="row" className={s.about}>
                          <span className={s.label}>{l.label}</span>
                          <span className={s.hint}>{p.mandatory ? `${l.hint}. Always on.` : l.hint}</span>
                        </th>
                        {(['in_app', 'email'] as const).map((channel) => (
                          <td key={channel} className={s.center}>
                            <input
                              type="checkbox"
                              className={s.check}
                              checked={p[channel]}
                              disabled={p.mandatory || save.busy}
                              aria-label={`${channel === 'in_app' ? 'In app' : 'Email'}: ${l.label}${p.mandatory ? ' (always on)' : ''}`}
                              onChange={(e) => void toggle(p, channel, e.target.checked)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </TableBox>
        ) : null}
        <p role="status" className="small secondary">
          {saved ?? ' '}
        </p>
        <ActionError error={save.error} />
      </Card>
    </>
  );
}
