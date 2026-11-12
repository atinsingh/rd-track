'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { Checkbox, TextField } from '@/components/ui/Field';
import { PasswordField } from '@/components/ui/PasswordField';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

// Where the subscription terms and DPA are published (set per deployment).
const TERMS_URL = process.env.NEXT_PUBLIC_TERMS_URL;
const DPA_URL = process.env.NEXT_PUBLIC_DPA_URL;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 12;
const RESEND_WAIT_S = 30;

function DocLink({ href, children }: { href: string | undefined; children: string }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  // Problems show once a field has been left, or after the first attempt to submit.
  const [touched, setTouched] = useState({ email: false, password: false });
  const [tried, setTried] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [wait, setWait] = useState(0);
  const action = useAction();
  const t = useT();

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  const address = email.trim();
  const emailError = EMAIL.test(address) ? null : t('pub.signup.emailInvalid');
  const passwordError = password.length >= MIN_PASSWORD ? null : t('password.tooShort');
  const termsError = accepted ? null : t('pub.signup.acceptRequired');

  // The request is saved server-side, so sending the same details again just issues a fresh link.
  const send = () => action.run(() => rd.auth.signup({ email: address, password, accept_terms: true }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (emailError || passwordError || termsError) return;
    if (await send()) {
      setSentTo(address);
      setResent(false);
      setWait(RESEND_WAIT_S);
    }
  };

  const resend = async () => {
    setResent(false);
    if (await send()) {
      setResent(true);
      setWait(RESEND_WAIT_S);
    }
  };

  return (
    <AuthFrame>
      {sentTo ? (
        <div className={s.form}>
          <span className="eyebrow">{t('pub.signup.checkEyebrow')}</span>
          <h1 className={s.title}>{t('pub.signup.confirmTitle')}</h1>
          <p role="status">
            {t('pub.signup.sentBefore')} <strong className={s.address}>{sentTo}</strong>
            {t('pub.signup.sentAfter')}
          </p>
          <p className={s.fine}>{t('pub.signup.spam')}</p>
          <ActionError error={action.error} />
          {resent ? (
            <p role="status" className={s.ok}>
              {t('pub.signup.resent')}
            </p>
          ) : null}
          <div className={s.actions}>
            <Button onClick={resend} disabled={action.busy || wait > 0}>
              {action.busy ? t('email.sending') : wait > 0 ? t('pub.signup.resendIn', { n: wait }) : t('pub.signup.resend')}
            </Button>
            <Button
              variant="link"
              onClick={() => {
                action.reset();
                setSentTo(null);
              }}
            >
              {t('pub.signup.changeEmail')}
            </Button>
          </div>
        </div>
      ) : (
        <form className={s.form} onSubmit={submit} noValidate>
          <span className="eyebrow">{t('pub.signup.eyebrow')}</span>
          <h1 className={s.title}>{t('pub.signup.title')}</h1>
          <p className={s.lede}>{t('pub.signup.free')}</p>
          <TextField
            label={t('login.email')}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((v) => ({ ...v, email: true }))}
            error={(tried || (touched.email && address)) && emailError ? emailError : null}
          />
          <PasswordField
            label={t('login.password')}
            name="new-password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((v) => ({ ...v, password: true }))}
            hint={passwordError ? t('password.rule') : null}
            error={(tried || (touched.password && password)) && passwordError ? passwordError : null}
          />
          <Checkbox
            label={
              <>
                {t('pub.signup.acceptBefore')} <DocLink href={TERMS_URL}>{t('pub.signup.terms')}</DocLink> {t('pub.signup.and')}{' '}
                <DocLink href={DPA_URL}>{t('pub.signup.dpa')}</DocLink> {t('pub.signup.acceptAfter')}
              </>
            }
            className={s.terms}
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            required
            aria-invalid={tried && termsError ? true : undefined}
          />
          {tried && termsError ? (
            <p role="alert" className={s.problem}>
              {termsError}
            </p>
          ) : null}
          <ActionError error={action.error} />
          <Button type="submit" variant="primary" disabled={action.busy}>
            {action.busy ? t('email.sending') : t('pub.signup.submit')}
          </Button>
          <p className={s.fine}>{t('pub.signup.next')}</p>
          <p className={s.alt}>
            {t('pub.signup.haveAccount')} <a href="/login">{t('pub.signup.signIn')}</a>
          </p>
        </form>
      )}
    </AuthFrame>
  );
}
