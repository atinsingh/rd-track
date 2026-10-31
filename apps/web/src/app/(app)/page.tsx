'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui/DataState';
import { useMe } from '@/lib/me';
import { HOME_KEY, homeFor } from '@/lib/nav';

/** "/" opens the person's home: the one they picked in the view switcher, or their role's. */
export default function Home() {
  const router = useRouter();
  const { access } = useMe();
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(HOME_KEY);
    } catch {
      // Storage can be blocked; the role's home is fine.
    }
    router.replace(homeFor(access, saved));
  }, [access, router]);
  return <Loading label="Opening your home" />;
}
