'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { platform } from '@/lib/platform';
import { useApi } from '@/lib/useApi';
import s from './console.module.css';

/** The operator realm's frame. Signed out or without MFA, it goes back to the operator sign-in. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/platform';
  const me = useApi('platform:me', (signal) => platform.me(signal));
  const needsSignIn = me.error?.code === 'unauthenticated' || (me.data && !me.data.mfa_verified);
  useEffect(() => {
    if (needsSignIn) router.replace('/platform/login');
  }, [needsSignIn, router]);

  if (me.error && !needsSignIn) return <ErrorState error={me.error} onRetry={me.reload} />;
  if (!me.data || needsSignIn) return <Loading label="Opening the operator console" />;
  const signOut = async () => {
    try {
      await platform.logout();
    } finally {
      router.replace('/platform/login');
    }
  };
  const link = (href: string, label: string) => (
    <Link href={href} className={s.navLink} aria-current={pathname === href ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <div className={s.frame}>
      <header className={s.bar}>
        <Link href="/platform" className={s.brand}>
          <Image src="/brand/rd-logo-reversed.png" alt="RoundDigital" width={112} height={24} />
          <span className={s.tag}>Platform</span>
        </Link>
        <nav className={s.nav} aria-label="Operator console">
          {link('/platform', 'Organizations')}
          {link('/platform/support', 'Support access')}
        </nav>
        <span className={s.who}>
          {me.data.display_name}
          <button type="button" className={s.signOut} onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      </header>
      <main id="main" className={s.main}>
        {children}
        <p className={s.rule}>Manage, not read: organizations&apos; activity, apps, screenshots and money are never shown here.</p>
      </main>
    </div>
  );
}
