'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { clientPortal } from '@/lib/portal';
import { useT } from '@/lib/i18n';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../../login/AuthFrame';
import s from '../../login/login.module.css';
import { ClientAbout } from '../ClientAbout';

/** Client portal sign-in (Stage 4 F9): separate from the staff sign-in. */
export default function ClientLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  const t = useT();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => clientPortal.login(email.trim(), password))) router.replace('/client');
  };
  return (
    <AuthFrame about={<ClientAbout />}>
      <form className={s.form} onSubmit={submit} noValidate>
        <span className="eyebrow">{t('pub.client.eyebrow')}</span>
        <h1 style={{ fontSize: 28 }}>{t('pub.client.title')}</h1>
        <TextField label={t('pub.client.email')} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label={t('login.password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ActionError error={action.error} />
        <Button type="submit" variant="primary" disabled={action.busy || !email || !password}>
          {action.busy ? t('mfa.checking') : t('login.submit')}
        </Button>
        <p className={s.fine}>{t('pub.client.forgot')}</p>
      </form>
    </AuthFrame>
  );
}
