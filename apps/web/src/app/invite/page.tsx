'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { browserTimeZone } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

/** Accepting an invite: the person chooses their own password; nobody else ever knew one. */
function Accept() {
  const token = useSearchParams().get('token') ?? '';
  const info = useApi(token ? `invite:${token}` : null, () => rd.auth.invite(token));
  const action = useAction();
  const t = useT();
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
        <span className="eyebrow">{t('pub.invite.eyebrow')}</span>
        <h1 style={{ fontSize: 28 }}>{t('pub.invite.badTitle')}</h1>
        <p className="secondary">{t('pub.invite.badBody')}</p>
        {info.error && info.error.code !== 'link_invalid' ? <ErrorState error={info.error} onRetry={info.reload} /> : null}
        <p className={s.fine}>
          {t('pub.invite.alreadySet')} <a href="/login">{t('pub.signup.signIn')}</a>
        </p>
      </div>
    );
  }
  if (!info.data) return <Loading label={t('pub.invite.checking')} />;
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">{t('pub.invite.join', { org: info.data.organization_name })}</span>
      <h1 style={{ fontSize: 28 }}>{t('pub.invite.welcome', { name: info.data.display_name })}</h1>
      <p className="secondary">
        {t('pub.invite.chooseBefore')} <strong>{info.data.email}</strong>
        {t('pub.invite.chooseAfter')}
      </p>
      <TextField
        label={t('login.password')}
        type="password"
        name="new-password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={short ? t('password.tooShort') : null}
      />
      <TextField
        label={t('pub.invite.passwordAgain')}
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        error={mismatch ? t('password.mismatch') : null}
      />
      <p className={s.fine}>{t('pub.invite.tz', { tz: browserTimeZone() })}</p>
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy || password.length < 12 || password !== again}>
        {action.busy ? t('pub.invite.joining') : t('pub.invite.submit')}
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
