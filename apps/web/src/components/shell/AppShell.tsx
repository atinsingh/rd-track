'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { rd } from '@/lib/api';
import { cx } from '@/lib/cx';
import { initials } from '@/lib/format';
import { useMe } from '@/lib/me';
import { activeHref, can, navFor, roleLabel } from '@/lib/nav';
import { timesheetsApi } from '@/lib/timesheets';
import { useApi } from '@/lib/useApi';
import { LicenceBanner } from './LicenceBanner';
import s from './shell.module.css';

export function AppShell({ children }: { children: ReactNode }) {
  const { me, access } = useMe();
  const pathname = usePathname() ?? '/';
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuOpen = menuFor === pathname;
  const groups = navFor(access);
  const current = activeHref(groups, pathname);

  const pending = useApi(access.managesTeams ? 'nav:pending' : null, (signal) => rd.corrections.pending(signal));
  const reviewsTimesheets = can(access, 'approvals') && access.entitlements.includes('timesheets');
  const pendingSheets = useApi(reviewsTimesheets ? 'nav:timesheets-pending' : null, (signal) => timesheetsApi.pending(signal));
  const pendingCount = (pending.data?.length ?? 0) + (pendingSheets.data?.length ?? 0);

  const signOut = async () => {
    try {
      await rd.auth.logout();
    } finally {
      // Full navigation so no data from the signed-out session stays in memory.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/login');
    }
  };

  return (
    <div className={s.app}>
      <a className={s.skip} href="#main">
        Skip to content
      </a>
      <nav className={s.rail} aria-label="Main">
        <div className={s.bar}>
          <Link href="/me" className={s.brand} aria-label="RoundDigital Track, my day">
            <Image src="/brand/rd-logo-reversed.png" alt="" width={112} height={24} priority />
            <span className={s.product} aria-hidden="true">
              TRACK
            </span>
          </Link>
          <button
            type="button"
            className={s.menuBtn}
            aria-expanded={menuOpen}
            aria-controls="rail-drawer"
            onClick={() => setMenuFor(menuOpen ? null : pathname)}
          >
            {menuOpen ? 'Close' : 'Menu'}
          </button>
        </div>
        <div id="rail-drawer" className={cx(s.drawer, menuOpen && s.drawerOpen)}>
          <div className={s.nav}>
            {groups.map((g) => (
              <div key={g.label} className={s.group}>
                <div className={s.groupLabel} id={`nav-${g.label}`}>
                  {g.label}
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-labelledby={`nav-${g.label}`}>
                  {g.items.map((i) => (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        className={s.link}
                        aria-current={current === i.href ? 'page' : undefined}
                        onClick={() => setMenuFor(null)}
                      >
                        {i.label}
                        {i.badge === 'approvals' && pendingCount > 0 ? (
                          <span className={s.count}>
                            {pendingCount}
                            <span className="visually-hidden"> pending</span>
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div>
            <div className={s.user}>
              <div className={s.avatar} aria-hidden="true">
                {initials(me.user.display_name)}
              </div>
              <div className={s.userText}>
                <span className={s.userName}>{me.user.display_name}</span>
                <span className={s.userRole}>{roleLabel(me)}</span>
              </div>
            </div>
            <button type="button" className={s.signOut} onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main id="main" className={s.main} tabIndex={-1}>
        <LicenceBanner />
        {children}
      </main>
    </div>
  );
}
