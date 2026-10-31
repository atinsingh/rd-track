'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { clientPortal } from '@/lib/portal';
import { useT } from '@/lib/i18n';
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
  const t = useT();
  const mismatch = again.length > 0 && again !== password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12 || mismatch) return;
    if (await action.run(() => clientPortal.acceptLink(token, password))) router.replace('/client');
  };
  if (!token || info.error)
    return (
      <div className={s.form}>
        <h1 style={{ fontSize: 28 }}>{t('pub.client.badLink')}</h1>
        {info.error ? <ErrorState error={info.error} /> : null}
        <p className={s.fine}>{t('pub.client.badLinkBody')}</p>
      </div>
    );
  if (!info.data) return <Loading label={t('pub.client.checkingLink')} />;
  const d = info.data;
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">{t('pub.client.portalEyebrow', { org: d.organization_name })}</span>
      <h1 style={{ fontSize: 28 }}>{d.first_time ? t('pub.invite.welcome', { name: d.display_name }) : t('pub.reset.chooseTitle')}</h1>
      <p className="secondary">{t('pub.client.shares', { org: d.organization_name, client: d.client_name, email: d.email })}</p>
      <TextField
        label={t('login.password')}
        type="password"
        autoComplete="new-password"
        hint={t('pub.client.atLeast12')}
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <TextField
        label={t('pub.invite.passwordAgain')}
        type="password"
        autoComplete="new-password"
        required
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        error={mismatch ? t('pub.client.different') : null}
      />
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy || password.length < 12 || again !== password}>
        {action.busy ? t('common.saving') : t('pub.client.saveSignIn')}
      </Button>
    </form>
  );
}

function LinkFallback() {
  const t = useT();
  return <Loading label={t('pub.client.checkingLink')} />;
}

export default function ClientLinkPage() {
  return (
    <AuthFrame about={<ClientAbout />}>
      <Suspense fallback={<LinkFallback />}>
        <ChoosePassword />
      </Suspense>
    </AuthFrame>
  );
}
