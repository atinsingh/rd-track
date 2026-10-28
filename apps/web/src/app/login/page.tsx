'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useAction } from '@/lib/useApi';
import { AuthFrame, safeNext } from './AuthFrame';
import s from './login.module.css';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await action.run(() => rd.auth.login(email.trim(), password));
    if (!res) return;
    if (res.mfa_required) {
      const q = new URLSearchParams({ next });
      if (!res.mfa_enrolled) q.set('enroll', '1');
      router.replace(`/login/mfa?${q.toString()}`);
    } else {
      router.replace(next);
    }
  };

  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">Track · Sign in</span>
      <h1 style={{ fontSize: 28 }}>Sign in</h1>
      <TextField
        label="Work email"
        type="email"
        name="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy || !email || !password}>
        {action.busy ? 'Signing in…' : 'Sign in →'}
      </Button>
      <p className={s.fine}>Admins and super admins confirm a 6-digit code from an authenticator app next.</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthFrame>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthFrame>
  );
}
