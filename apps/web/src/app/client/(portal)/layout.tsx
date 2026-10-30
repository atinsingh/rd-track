'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { OrgLogo } from '@/components/OrgLogo';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { t } from '@/lib/i18n';
import { clientPortal } from '@/lib/portal';
import { announceLocale, resolveLocale, setLocale } from '@/lib/locale';
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
  // The agency's language and formats, else the browser's (G27).
  const locale = me.data ? resolveLocale(null, me.data.organization.locale) : null;
  if (locale) setLocale(locale, false);
  useEffect(() => {
    if (locale) announceLocale();
  }, [locale]);

  if (me.error && !signedOut)
    return (
      <main className={s.main}>
        <ErrorState error={me.error} onRetry={me.reload} />
      </main>
    );
  if (!me.data || signedOut) return <Loading label={t('pub.portal.opening')} />;
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
            <span className={s.tag}>{t('pub.portal.tag')}</span>
          </Link>
          <OrgLogo url={me.data.organization.logo_url} name={me.data.organization.name} />
          <span className={s.who}>
            {me.data.contact.display_name} · {me.data.client.name}
            <button type="button" className={s.signOut} onClick={() => void signOut()}>
              {t('pub.portal.signOut')}
            </button>
          </span>
        </header>
        <main id="main" className={s.main}>
          {children}
          <p className={s.rule}>
            {t('pub.portal.rule', { org: me.data.organization.name })}
          </p>
        </main>
      </div>
    </PortalMe.Provider>
  );
}
