'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { SSO_ERRORS, type SsoDiscoverResponse, type SsoErrorCode } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { Banner } from '@/components/ui/Layout';
import { ApiError, rd } from '@/lib/api';
import { ssoErrorText, useT } from '@/lib/i18n';
import { useAction } from '@/lib/useApi';
import { AuthFrame, safeNext } from './AuthFrame';
import s from './login.module.css';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const ssoError = params.get('sso_error') as SsoErrorCode | null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // How the typed address signs in (slice 6a): looked up as it's typed, for the right button.
  const [route, setRoute] = useState<{ email: string; r: SsoDiscoverResponse } | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const action = useAction();
  const t = useT();

  const typed = email.trim().toLowerCase();
  useEffect(() => {
    if (!EMAIL.test(typed)) return;
    let live = true;
    const t = window.setTimeout(() => {
      rd.auth
        .ssoDiscover(typed)
        .then((r) => live && setRoute({ email: typed, r }))
        .catch(() => undefined);
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [typed]);
  const sso = route?.email === typed && route.r.method === 'sso' ? route.r : null;
  const showPassword = !sso || (sso.password_allowed && usePassword);

  const startSso = async () => {
    const r = await action.run(() => rd.auth.ssoStart(typed, next));
    if (r) window.location.assign(r.redirect_url);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!showPassword) return startSso();
    const res = await action.run(async () => {
      try {
        return await rd.auth.login(typed, password);
      } catch (err) {
        // Single sign-on is required for this address: go there instead.
        if (err instanceof ApiError && err.code === 'sso_required') {
          await startSso();
          return null;
        }
        throw err;
      }
    });
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
      <span className="eyebrow">{t('login.eyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('login.title')}</h1>
      {ssoError && SSO_ERRORS[ssoError] ? (
        <Banner tone="warn" role="alert" title={t('login.ssoFailed')}>
          {ssoErrorText(t, ssoError)}
        </Banner>
      ) : null}
      <TextField
        label={t('login.email')}
        type="email"
        name="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setUsePassword(false);
        }}
      />
      {showPassword ? (
        <TextField
          label={t('login.password')}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      ) : (
        <p className="small secondary">{t('login.ssoNote')}</p>
      )}
      <ActionError error={action.error} />
      {showPassword ? (
        <Button type="submit" variant="primary" disabled={action.busy || !email || !password}>
          {action.busy ? t('login.signingIn') : t('login.submit')}
        </Button>
      ) : (
        <Button type="submit" variant="primary" disabled={action.busy}>
          {action.busy ? t('login.opening') : t('login.ssoSubmit')}
        </Button>
      )}
      {sso?.password_allowed ? (
        <p className={s.fine}>
          <Button variant="link" onClick={() => setUsePassword((v) => !v)}>
            {usePassword ? t('login.useSso') : t('login.usePassword')}
          </Button>
        </p>
      ) : null}
      {showPassword ? (
        <p className={s.fine}>
          <a href="/reset">{t('login.forgot')}</a>
        </p>
      ) : null}
      <p className={s.fine}>{t('login.mfaNote')}</p>
      <p className={s.fine}>
        {t('login.newPrefix')} <a href="/signup">{t('login.newLink')}</a> {t('login.newSuffix')}
      </p>
      <p className={s.fine}>
        {t('login.clientPrefix')} <a href="/client/login">{t('login.clientLink')}</a>.
      </p>
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
