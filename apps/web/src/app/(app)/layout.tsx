'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { MeProvider } from '@/lib/me';
import { useApi } from '@/lib/useApi';
import s from './gate.module.css';

const PRIVILEGED = new Set(['org_admin', 'super_admin']);

export default function SignedInLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useApi('me', (signal) => rd.me({ signal }));
  const needsMfa = !!me.data && PRIVILEGED.has(me.data.user.org_role) && !me.data.mfa_verified;

  useEffect(() => {
    if (needsMfa) router.replace(`/login/mfa?next=${encodeURIComponent(window.location.pathname)}`);
  }, [needsMfa, router]);

  if (me.error) {
    const redirecting = me.error.code === 'unauthenticated' || me.error.code === 'mfa_required';
    return (
      <div className={s.gate}>
        {redirecting ? <Loading label="Redirecting to sign in" /> : <ErrorState error={me.error} onRetry={me.reload} />}
      </div>
    );
  }
  if (!me.data || needsMfa) {
    return (
      <div className={s.gate}>
        <Loading label={needsMfa ? 'Two-factor verification required' : 'Loading your workspace'} />
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
