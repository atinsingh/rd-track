'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ApiError, rd } from '@/lib/api';
import { AuthFrame } from '../../login/AuthFrame';
import s from '../../login/login.module.css';

function Verify() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its token.');
  const started = useRef(false);

  useEffect(() => {
    // Verification links are single-use: never send the token twice (e.g. React strict mode).
    if (!token || started.current) return;
    started.current = true;
    rd.auth
      .verifySignup(token)
      .then(() => router.replace('/admin/billing'))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Something went wrong. Try the link again.'));
  }, [token, router]);

  return error ? (
    <div className={s.form} role="alert">
      <span className="eyebrow">Track · Confirm email</span>
      <h1 style={{ fontSize: 28 }}>That link didn&apos;t work</h1>
      <p>{error}</p>
      <p className={s.fine}>
        <a href="/signup">Sign up again</a> or <a href="/login">sign in</a>.
      </p>
    </div>
  ) : (
    <div className={s.form} role="status">
      <span className="eyebrow">Track · Confirm email</span>
      <h1 style={{ fontSize: 28 }}>Setting up your organization…</h1>
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
