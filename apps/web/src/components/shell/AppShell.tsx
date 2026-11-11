'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { OrgLogo } from '@/components/OrgLogo';
import { rd } from '@/lib/api';
import { cx } from '@/lib/cx';
import { onApprovalsChanged } from '@/lib/events';
import { initials } from '@/lib/format';
import { useMe } from '@/lib/me';
import { useT } from '@/lib/i18n';
import { HOME_KEY, activeHref, can, groupOf, homesFor, navFor, roleLabel, type NavGroupKey } from '@/lib/nav';
import { useApi } from '@/lib/useApi';
import { ClosingBanner } from './ClosingBanner';
import { CommandPalette } from './CommandPalette';
import { LicenceBanner } from './LicenceBanner';
import { NotificationBell } from './NotificationBell';
import s from './shell.module.css';

const COLLAPSED_KEY = 'rd.nav.collapsed';

/** Which groups the person folded away, remembered in this browser only. */
function readCollapsed(): NavGroupKey[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is NavGroupKey => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeCollapsed(keys: NavGroupKey[]) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(keys));
  } catch {
    // Private windows and blocked storage: folding still works for this visit.
  }
}

// The shell renders only in the browser (after /v1/me), so reading the platform here is safe.
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function AppShell({ children }: { children: ReactNode }) {
  const { me, access } = useMe();
  const t = useT();
  const pathname = usePathname() ?? '/';
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuOpen = menuFor === pathname;
  const router = useRouter();
  const groups = navFor(access);
  const homes = homesFor(access);
  const current = activeHref(groups, pathname);
  const currentGroup = groupOf(groups, current);
  const [collapsed, setCollapsed] = useState<NavGroupKey[]>(readCollapsed);
  const toggleGroup = (key: NavGroupKey) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    writeCollapsed(next);
  };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mac] = useState(isMac);
  const shortcut = mac ? '⌘K' : 'Ctrl K';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMenuFor(null);
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const counts = useApi(can(access, 'approvals') ? 'nav:inbox-counts' : null, (signal) => rd.approvals.counts(signal));
  const pendingCount = counts.data?.total ?? 0;
  const { reload: reloadCounts } = counts;
  useEffect(() => onApprovalsChanged(reloadCounts), [reloadCounts]);

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
        {t('shell.skip')}
      </a>
      <nav className={s.rail} aria-label={t('shell.mainNav')}>
        <div className={s.bar}>
          <Link href="/" className={s.brand} aria-label={t('shell.home')}>
            <Image src="/brand/rd-logo-reversed.png" alt="" width={112} height={24} priority />
            <span className={s.product} aria-hidden="true">
              TRACK
            </span>
          </Link>
          <div className={s.barActions}>
            <NotificationBell />
            <button
              type="button"
              className={s.menuBtn}
              aria-expanded={menuOpen}
              aria-controls="rail-drawer"
              onClick={() => setMenuFor(menuOpen ? null : pathname)}
            >
              {menuOpen ? t('shell.close') : t('shell.menu')}
            </button>
          </div>
        </div>
        <div id="rail-drawer" className={cx(s.drawer, menuOpen && s.drawerOpen)}>
          <OrgLogo url={me.organization.logo_url} name={me.organization.name} className={s.orgLogo} />
          <button
            type="button"
            className={s.search}
            onClick={() => {
              setMenuFor(null);
              setPaletteOpen(true);
            }}
            aria-label={t('shell.jumpLabel')}
            aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <span className={s.searchText}>{t('shell.jump')}</span>
            <kbd className={s.kbd} aria-hidden="true">
              {shortcut}
            </kbd>
          </button>
          {homes.length > 1 ? (
            <div className={s.view}>
              <label htmlFor="rail-view" className={s.viewLabel}>
                {t('shell.view')}
              </label>
              <select
                id="rail-view"
                className={s.viewSelect}
                value={homes.find((h) => pathname === h.href || pathname.startsWith(`${h.href}/`))?.href ?? ''}
                onChange={(e) => {
                  const href = e.target.value;
                  try {
                    window.localStorage.setItem(HOME_KEY, href);
                  } catch {
                    // Not remembered; still go there.
                  }
                  setMenuFor(null);
                  router.push(href);
                }}
              >
                <option value="" disabled>
                  {t('shell.chooseView')}
                </option>
                {homes.map((h) => (
                  <option key={h.href} value={h.href}>
                    {h.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className={s.nav}>
            {groups.map((g) => {
              // The group with the page you're on never folds away.
              const holdsCurrent = g.key === currentGroup;
              const open = holdsCurrent || !collapsed.includes(g.key);
              const listId = `nav-${g.key}`;
              const badge = g.items.some((i) => i.badge === 'approvals') && pendingCount > 0;
              return (
                <div key={g.key} className={s.group}>
                  <button
                    type="button"
                    className={s.groupBtn}
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-disabled={holdsCurrent || undefined}
                    title={holdsCurrent ? t('shell.holdsCurrent') : undefined}
                    onClick={() => {
                      if (!holdsCurrent) toggleGroup(g.key);
                    }}
                  >
                    <span>{g.label}</span>
                    <span className={s.groupMeta}>
                      {!open ? (
                        <span className={cx(s.groupCount, badge && s.groupCountAlert)}>
                          {badge ? (
                            <>
                              {pendingCount}
                              <span className="visually-hidden">{t('shell.pendingApprovals')}</span>
                            </>
                          ) : (
                            <>
                              {g.items.length}
                              <span className="visually-hidden">{t('shell.pages')}</span>
                            </>
                          )}
                        </span>
                      ) : null}
                      <svg className={cx(s.chev, open && s.chevOpen)} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </span>
                  </button>
                  <ul id={listId} className={s.items} hidden={!open} aria-label={g.label}>
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
                              <span className="visually-hidden">{t('shell.pending')}</span>
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
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
              {t('shell.signOut')}
            </button>
          </div>
        </div>
      </nav>
      <main id="main" className={s.main} tabIndex={-1}>
        <LicenceBanner />
        <ClosingBanner />
        {children}
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} groups={groups} />
    </div>
  );
}
