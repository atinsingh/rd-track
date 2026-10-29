'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { clientPortal } from '@/lib/portal';
import { useAction, useApi } from '@/lib/useApi';
import { AuthFrame } from '../../login/AuthFrame';
import s from '../../login/login.module.css';
import { ClientAbout } from '../ClientAbout';

/** A sign-in link from the agency: choose a password (the first time, or a new one). */
function ChoosePassword() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const info = useApi(token ? `client:link|${token}` : null, (signal) => clientPortal.linkInfo(token, signal));
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const action = useAction();
  const mismatch = again.length > 0 && again !== password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12 || mismatch) return;
    if (await action.run(() => clientPortal.acceptLink(token, password))) router.replace('/client');
  };
  if (!token || info.error)
    return (
      <div className={s.form}>
        <h1 style={{ fontSize: 28 }}>This link doesn&apos;t work</h1>
        {info.error ? <ErrorState error={info.error} /> : null}
        <p className={s.fine}>Links work once and expire after 7 days. Ask your contact at the agency to send a new one.</p>
      </div>
    );
  if (!info.data) return <Loading label="Checking your link" />;
  const d = info.data;
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">{d.organization_name} · Client portal</span>
      <h1 style={{ fontSize: 28 }}>{d.first_time ? `Welcome, ${d.display_name}` : 'Choose a new password'}</h1>
      <p className="secondary">
        {d.organization_name} shares the hours, budgets and invoices for {d.client_name}&apos;s projects with you. You sign in as {d.email}.
      </p>
      <TextField label="Password" type="password" autoComplete="new-password" hint="At least 12 characters" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <TextField label="Password again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ? 'The passwords are different.' : null} />
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy || password.length < 12 || again !== password}>
        {action.busy ? 'Saving…' : 'Save and sign in →'}
      </Button>
    </form>
  );
}

export default function ClientLinkPage() {
  return (
    <AuthFrame about={<ClientAbout />}>
      <Suspense fallback={<Loading label="Checking your link" />}>
        <ChoosePassword />
      </Suspense>
    </AuthFrame>
  );
}
