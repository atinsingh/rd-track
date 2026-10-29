'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

function RequestLink() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => rd.auth.requestPasswordReset(email.trim()));
    if (ok) setSent(email.trim());
  };
  if (sent) {
    return (
      <div className={s.form} role="status">
        <span className="eyebrow">Track · Check your email</span>
        <h1 style={{ fontSize: 28 }}>Check your email</h1>
        <p>
          If <strong>{sent}</strong> has an account, a link to choose a new password is on its way. It works once, for 60 minutes.
        </p>
        <p className={s.fine}>
          Remembered it? <a href="/login">Sign in</a>
        </p>
      </div>
    );
  }
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">Track · Reset password</span>
      <h1 style={{ fontSize: 28 }}>Forgot your password?</h1>
      <p className="secondary">Enter your work email and we’ll send a link to choose a new one.</p>
      <TextField label="Work email" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy || !email.includes('@')}>
        {action.busy ? 'Sending…' : 'Send the link →'}
      </Button>
      <p className={s.fine}>
        <a href="/login">Back to sign in</a>
      </p>
    </form>
  );
}

function ChooseNew({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12 || password !== again) return;
    if (await action.run(() => rd.auth.confirmPasswordReset(token, password))) setDone(true);
  };
  if (done) {
    return (
      <div className={s.form} role="status">
        <span className="eyebrow">Track · Password changed</span>
        <h1 style={{ fontSize: 28 }}>Your password is changed</h1>
        <p>You were signed out everywhere else. Sign in with your new password.</p>
        <a className={s.primaryLink} href="/login">
          Sign in →
        </a>
      </div>
    );
  }
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">Track · Reset password</span>
      <h1 style={{ fontSize: 28 }}>Choose a new password</h1>
      <TextField
        label="New password"
        type="password"
        name="new-password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={password.length > 0 && password.length < 12 ? 'Use at least 12 characters.' : null}
      />
      <TextField
        label="New password again"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        error={again.length > 0 && again !== password ? 'The passwords don’t match.' : null}
      />
      <ActionError error={action.error} />
      {action.error?.code === 'link_invalid' ? (
        <p className={s.fine}>
          <a href="/reset">Get a new link</a>
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={action.busy || password.length < 12 || password !== again}>
        {action.busy ? 'Saving…' : 'Change password →'}
      </Button>
    </form>
  );
}

function Reset() {
  const token = useSearchParams().get('token');
  return token ? <ChooseNew token={token} /> : <RequestLink />;
}

export default function ResetPage() {
  return (
    <AuthFrame>
      <Suspense>
        <Reset />
      </Suspense>
    </AuthFrame>
  );
}
