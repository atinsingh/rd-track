'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import s from './login.module.css';

/** `about` replaces the left panel's words, for sign-ins that aren't for the people being tracked (the client portal). */
export function AuthFrame({ children, about }: { children: ReactNode; about?: ReactNode }) {
  const t = useT();
  return (
    <div className={s.page}>
      <aside className={s.aside} aria-label={t('auth.about')}>
        <Image src="/brand/rd-logo-reversed.png" alt="RoundDigital" width={112} height={24} className={s.reversed} />
        {about ?? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h2>{t('auth.headline')}</h2>
              <ul>
                <li>{t('auth.point1')}</li>
                <li>{t('auth.point2')}</li>
                <li>{t('auth.point3')}</li>
              </ul>
            </div>
            <p className={s.fine} style={{ color: 'var(--ink-muted)' }}>
              {t('auth.neverRecorded', { list: t('auth.neverList') })}
            </p>
          </>
        )}
      </aside>
      <main className={s.panel}>
        <div className={s.card}>
          <Image src="/brand/rd-logo-color.png" alt="RoundDigital" width={131} height={28} className={s.logo} priority />
          {children}
        </div>
      </main>
    </div>
  );
}

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/';
  return next;
}
