'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { platform } from '@/lib/platform';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../../login/AuthFrame';
import s from '../../login/login.module.css';

/** Operator sign-in: password, then the authenticator code (always required). */
export default function PlatformLogin() {
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step === 'password') {
      if (await action.run(() => platform.login(email.trim(), password))) setStep('code');
    } else if (await action.run(() => platform.verify(code.trim()))) {
      router.replace('/platform');
    }
  };
  return (
    <AuthFrame>
      <form className={s.form} onSubmit={submit} noValidate>
        <span className="eyebrow">RoundDigital · Platform operators</span>
        <h1 style={{ fontSize: 28 }}>{step === 'password' ? 'Operator sign-in' : 'Enter your code'}</h1>
        {step === 'password' ? (
          <>
            <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        ) : (
          <TextField label="6-digit code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        )}
        <ActionError error={action.error} />
        <Button type="submit" variant="primary" disabled={action.busy || (step === 'password' ? !email || !password : code.trim().length < 6)}>
          {action.busy ? 'Checking…' : step === 'password' ? 'Continue →' : 'Sign in →'}
        </Button>
        <p className={s.fine}>
          Operators manage organizations, plans and seats. Reading an organization&apos;s setup needs support access its admins approve, and every read is
          in their audit log. Activity, apps and screenshots are never available here.
        </p>
      </form>
    </AuthFrame>
  );
}
