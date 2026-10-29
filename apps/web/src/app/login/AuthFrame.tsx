import Image from 'next/image';
import type { ReactNode } from 'react';
import { NEVER_COLLECTED } from '@rd/contracts';
import s from './login.module.css';

/** `about` replaces the left panel's words, for sign-ins that aren't for the people being tracked (the client portal). */
export function AuthFrame({ children, about }: { children: ReactNode; about?: ReactNode }) {
  return (
    <div className={s.page}>
      <aside className={s.aside} aria-label="About RoundDigital Track">
        <Image src="/brand/rd-logo-reversed.png" alt="RoundDigital" width={112} height={24} className={s.reversed} />
        {about ?? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h2>Time and computer activity, out in the open.</h2>
              <ul>
                <li>Nothing is collected outside a work session you start.</li>
                <li>You see everything your manager can see about you.</li>
                <li>Screenshots are off unless a published policy turns them on.</li>
              </ul>
            </div>
            <p className={s.fine} style={{ color: 'var(--ink-muted)' }}>
              Never recorded: {NEVER_COLLECTED}
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
