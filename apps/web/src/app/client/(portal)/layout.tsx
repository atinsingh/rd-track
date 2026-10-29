'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { clientPortal } from '@/lib/portal';
import { useApi } from '@/lib/useApi';
import { PortalMe } from './PortalMe';
import s from './portal.module.css';

/** The client portal's frame (Stage 4 F9). Signed out, it goes to the client sign-in. */
export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useApi('client:me', (signal) => clientPortal.me(signal));
  const signedOut = me.error?.code === 'unauthenticated';
  useEffect(() => {
    if (signedOut) router.replace('/client/login');
  }, [signedOut, router]);

  if (me.error && !signedOut)
    return (
      <main className={s.main}>
        <ErrorState error={me.error} onRetry={me.reload} />
      </main>
    );
  if (!me.data || signedOut) return <Loading label="Opening your projects" />;
  const signOut = async () => {
    try {
      await clientPortal.logout();
    } finally {
      router.replace('/client/login');
    }
  };
  return (
    <PortalMe.Provider value={me.data}>
      <div className={s.frame}>
        <header className={s.bar}>
          <Link href="/client" className={s.brand}>
            <Image src="/brand/rd-logo-reversed.png" alt="RoundDigital" width={112} height={24} />
            <span className={s.tag}>Client portal</span>
          </Link>
          <span className={s.who}>
            {me.data.contact.display_name} · {me.data.client.name}
            <button type="button" className={s.signOut} onClick={() => void signOut()}>
              Sign out
            </button>
          </span>
        </header>
        <main id="main" className={s.main}>
          {children}
          <p className={s.rule}>
            Read-only, shared by {me.data.organization.name}. Nobody&apos;s computer activity, apps or screenshots are shown here.
          </p>
        </main>
      </div>
    </PortalMe.Provider>
  );
}
