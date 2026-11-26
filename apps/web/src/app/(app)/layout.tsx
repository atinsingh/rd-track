'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { MeProvider } from '@/lib/me';
import { PENDING_TZ_KEY } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import s from './gate.module.css';

const PRIVILEGED = new Set(['org_admin', 'super_admin', 'finance']);

export default function SignedInLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  // The hook, not the module `t`: it renders the server's language until hydrated (G27).
  const t = useT();
  const me = useApi('me', (signal) => rd.me({ signal }));
  const needsMfa = !!me.data && PRIVILEGED.has(me.data.user.org_role) && !me.data.mfa_verified;

  useEffect(() => {
    if (needsMfa) router.replace(`/login/mfa?next=${encodeURIComponent(window.location.pathname)}`);
  }, [needsMfa, router]);

  // A new founder's browser time zone, kept by sign-up: saved once, while the account still has the UTC default.
  const ready = !!me.data && !needsMfa;
  const { reload } = me;
  useEffect(() => {
    if (!ready) return;
    let tz: string | null = null;
    try {
      tz = window.sessionStorage.getItem(PENDING_TZ_KEY);
      window.sessionStorage.removeItem(PENDING_TZ_KEY);
    } catch {
      // Blocked storage: nothing was kept.
    }
    if (tz && tz !== 'UTC' && me.data?.user.timezone === 'UTC') void rd.account.update({ timezone: tz }).then(reload, () => undefined);
  }, [ready, me.data?.user.timezone, reload]);

  if (me.error) {
    const redirecting = me.error.code === 'unauthenticated' || me.error.code === 'mfa_required';
    return (
      <div className={s.gate}>
        {redirecting ? <Loading label={t('common.redirectingSignIn')} /> : <ErrorState error={me.error} onRetry={me.reload} />}
      </div>
    );
  }
  if (!me.data || needsMfa) {
    return (
      <div className={s.gate}>
        <Loading label={needsMfa ? t('common.mfaRequired') : t('common.loadingWorkspace')} />
      </div>
    );
  }
  return (
    <MeProvider me={me.data} reload={me.reload}>
      <AppShell>
        <Suspense fallback={<Loading />}>{children}</Suspense>
      </AppShell>
    </MeProvider>
  );
}
