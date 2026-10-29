'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { browserTimeZone } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

/** Accepting an invite: the person chooses their own password; nobody else ever knew one. */
function Accept() {
  const token = useSearchParams().get('token') ?? '';
  const info = useApi(token ? `invite:${token}` : null, () => rd.auth.invite(token));
  const action = useAction();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const short = password.length > 0 && password.length < 12;
  const mismatch = again.length > 0 && again !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12 || password !== again) return;
    const ok = await action.run(() => rd.auth.acceptInvite({ token, password, timezone: browserTimeZone() }));
    // A full load picks up the new session; admins are taken through two-factor setup on the way in.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (ok) window.location.assign('/');
  };

  if (!token || info.error) {
    return (
      <div className={s.form}>
        <span className="eyebrow">Track · Invite</span>
        <h1 style={{ fontSize: 28 }}>This invite link doesn’t work</h1>
        <p className="secondary">It may have expired (after 7 days) or been used already. Ask your org admin to send a new one.</p>
        {info.error && info.error.code !== 'link_invalid' ? <ErrorState error={info.error} onRetry={info.reload} /> : null}
        <p className={s.fine}>
          Already set a password? <a href="/login">Sign in</a>
        </p>
      </div>
    );
  }
  if (!info.data) return <Loading label="Checking your invite" />;
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">Track · Join {info.data.organization_name}</span>
      <h1 style={{ fontSize: 28 }}>Welcome, {info.data.display_name}</h1>
      <p className="secondary">
        Choose a password for <strong>{info.data.email}</strong>. Nothing is measured until you start a work session, and you can see
        everything that is collected about you.
      </p>
      <TextField
        label="Password"
        type="password"
        name="new-password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={short ? 'Use at least 12 characters.' : null}
      />
      <TextField
        label="Password again"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        error={mismatch ? 'The passwords don’t match.' : null}
      />
      <p className={s.fine}>Your time zone is set to {browserTimeZone()}; you can change it later in Settings.</p>
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy || password.length < 12 || password !== again}>
        {action.busy ? 'Joining…' : 'Join and sign in →'}
      </Button>
    </form>
  );
}

export default function InvitePage() {
  return (
    <AuthFrame>
      <Suspense>
        <Accept />
      </Suspense>
    </AuthFrame>
  );
}
