'use client';

import Link from 'next/link';
import { cx } from '@/lib/cx';
import { useMe } from '@/lib/me';
import s from './timesheet.module.css';

/** "Sessions | Timesheets" tabs on My time (timesheets need the plan entitlement). */
export function TimeTabs({ current }: { current: 'sessions' | 'timesheets' }) {
  const { access } = useMe();
  if (!access.entitlements.includes('timesheets')) return null;
  const tabs = [
    { id: 'sessions', href: '/me/time', label: 'Sessions' },
    { id: 'timesheets', href: '/me/time/timesheet', label: 'Timesheets' },
  ] as const;
  return (
    <nav aria-label="My time" className={s.tabs}>
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          className={cx(s.tab, current === t.id && s.tabActive)}
          aria-current={current === t.id ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
