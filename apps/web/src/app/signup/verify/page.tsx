'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ApiError, rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AuthFrame } from '../../login/AuthFrame';
import s from '../../login/login.module.css';

function Verify() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const t = useT();
  // null: no error; '' stands for the missing token, shown in the reader's language.
  const [error, setError] = useState<string | null>(token ? null : '');
  const started = useRef(false);

  useEffect(() => {
    // Verification links are single-use: never send the token twice (e.g. React strict mode).
    if (!token || started.current) return;
    started.current = true;
    rd.auth
      .verifySignup(token)
      .then(() => router.replace('/admin/billing'))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'failed'));
  }, [token, router]);

  return error !== null ? (
    <div className={s.form} role="alert">
      <span className="eyebrow">{t('pub.verify.eyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('pub.verify.badTitle')}</h1>
      <p>{error === '' ? t('pub.verify.missingToken') : error === 'failed' ? t('pub.verify.failed') : error}</p>
      <p className={s.fine}>
        <a href="/signup">{t('pub.verify.signUpAgain')}</a> {t('pub.verify.or')} <a href="/login">{t('pub.verify.signIn')}</a>.
      </p>
    </div>
  ) : (
    <div className={s.form} role="status">
      <span className="eyebrow">{t('pub.verify.eyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('pub.verify.settingUp')}</h1>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <AuthFrame>
      <Suspense>
        <Verify />
      </Suspense>
    </AuthFrame>
  );
}
