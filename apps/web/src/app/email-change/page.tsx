'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

/** Confirms a new sign-in address; a button rather than on load, so link scanners can't confirm it. */
function Confirm() {
  const token = useSearchParams().get('token') ?? '';
  const action = useAction();
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <div className={s.form} role="status">
        <span className="eyebrow">Track · Email changed</span>
        <h1 style={{ fontSize: 28 }}>Your email is changed</h1>
        <p>Sign in with this address from now on. We let your old address know.</p>
        <a className={s.primaryLink} href="/login">
          Sign in →
        </a>
      </div>
    );
  }
  return (
    <div className={s.form}>
      <span className="eyebrow">Track · Confirm email</span>
      <h1 style={{ fontSize: 28 }}>Use this address to sign in?</h1>
      <p className="secondary">Confirming replaces the email on your RoundDigital Track account.</p>
      <ActionError error={action.error} />
      <Button variant="primary" disabled={!token || action.busy} onClick={async () => setDone(Boolean(await action.run(() => rd.auth.confirmEmailChange(token))))}>
        {action.busy ? 'Confirming…' : 'Confirm new email →'}
      </Button>
    </div>
  );
}

export default function EmailChangePage() {
  return (
    <AuthFrame>
      <Suspense>
        <Confirm />
      </Suspense>
    </AuthFrame>
  );
}
