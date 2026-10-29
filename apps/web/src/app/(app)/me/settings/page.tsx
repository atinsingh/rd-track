'use client';

import { useState } from 'react';
import { type NotificationCategory, type NotificationPreference } from '@rd/contracts';
import { ApiTokens } from '@/components/developers/ApiTokens';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { can, type Access } from '@/lib/nav';
import { t, type MessageKey } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { LanguageCard, ProfileCard, SecurityCard } from './AccountCards';
import s from './settings.module.css';

/** A category's name and what it covers, in the reader's language. */
const categoryLabel = (c: NotificationCategory) => ({ label: t(`prefs.cat.${c}.label` as MessageKey), hint: t(`prefs.cat.${c}.hint` as MessageKey) });

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
      setSaved(t('prefs.saved', { label: categoryLabel(p.category).label }));
    } else prefs.reload();
  };

  return (
    <>
      <PageHeader
        eyebrow={t('settings.eyebrow')}
        title={t('settings.title')}
        description={t('settings.description', { email: me.user.email })}
      />
      <ProfileCard />
      <LanguageCard />
      <SecurityCard />
      {access.entitlements.includes('api_access') ? (
        <div id="api-tokens">
          <ApiTokens mode="personal" />
        </div>
      ) : null}
      <Card title={t('prefs.title')} subtitle={t('prefs.subtitle')}>
        {prefs.error ? <ErrorState error={prefs.error} onRetry={prefs.reload} /> : null}
        {!prefs.data && !prefs.error ? <Loading label={t('prefs.loading')} /> : null}
        {prefs.data ? (
          <TableBox label={t('prefs.table')}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">{t('prefs.about')}</th>
                  <th scope="col" className={s.center}>
                    {t('prefs.inApp')}
                  </th>
                  <th scope="col" className={s.center}>
                    {t('prefs.email')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {prefs.data.items
                  .filter((p) => relevant(p.category, access))
                  .map((p) => {
                    const l = categoryLabel(p.category);
                    return (
                      <tr key={p.category}>
                        <th scope="row" className={s.about}>
                          <span className={s.label}>{l.label}</span>
                          <span className={s.hint}>{p.mandatory ? t('prefs.alwaysOn', { hint: l.hint }) : l.hint}</span>
                        </th>
                        {(['in_app', 'email'] as const).map((channel) => (
                          <td key={channel} className={s.center}>
                            <input
                              type="checkbox"
                              className={s.check}
                              checked={p[channel]}
                              disabled={p.mandatory || save.busy}
                              aria-label={`${channel === 'in_app' ? t('prefs.inApp') : t('prefs.email')}: ${l.label}${p.mandatory ? t('prefs.alwaysOnSuffix') : ''}`}
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
