'use client';

import { useT } from '@/lib/i18n';
import s from '../login/login.module.css';

/** The sign-in panel's words for clients (Stage 4 F9). */
export function ClientAbout() {
  const t = useT();
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <h2>{t('pub.client.aboutTitle')}</h2>
        <ul>
          <li>{t('pub.client.about1')}</li>
          <li>{t('pub.client.about2')}</li>
          <li>{t('pub.client.about3')}</li>
        </ul>
      </div>
      <p className={s.fine} style={{ color: 'var(--ink-muted)' }}>
        {t('pub.client.readOnly')}
      </p>
    </>
  );
}
