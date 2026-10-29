'use client';

import Link from 'next/link';
import { cx } from '@/lib/cx';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';
import s from './timesheet.module.css';

/** "Sessions | Timesheets" tabs on My time (timesheets need the plan entitlement). */
export function TimeTabs({ current }: { current: 'sessions' | 'timesheets' }) {
  const { access } = useMe();
  if (!access.entitlements.includes('timesheets')) return null;
  const tabs = [
    { id: 'sessions', href: '/me/time', label: t('time.tab.sessions') },
    { id: 'timesheets', href: '/me/time/timesheet', label: t('time.tab.timesheets') },
  ] as const;
  return (
    <nav aria-label={t('time.tabs')} className={s.tabs}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={cx(s.tab, current === tab.id && s.tabActive)}
          aria-current={current === tab.id ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
