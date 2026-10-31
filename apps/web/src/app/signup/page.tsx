'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { Checkbox, TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

// Where the subscription terms and DPA are published (set per deployment).
const TERMS_URL = process.env.NEXT_PUBLIC_TERMS_URL;
const DPA_URL = process.env.NEXT_PUBLIC_DPA_URL;

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
  const [form, setForm] = useState({ org_name: '', display_name: '', email: '', password: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const action = useAction();
  const t = useT();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const passwordShort = form.password.length > 0 && form.password.length < 12;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => rd.auth.signup({ ...form, email: form.email.trim(), accept_terms: true }));
    if (r) setSentTo(form.email.trim());
  };

  return (
    <AuthFrame>
      {sentTo ? (
        <div className={s.form} role="status">
          <span className="eyebrow">{t('pub.signup.checkEyebrow')}</span>
          <h1 style={{ fontSize: 28 }}>{t('pub.signup.confirmTitle')}</h1>
          <p>
            {t('pub.signup.sentBefore')} <strong>{sentTo}</strong>
            {t('pub.signup.sentAfter')}
          </p>
          <p className={s.fine}>
            {t('pub.signup.nothingBefore')} <a href="/signup">{t('pub.signup.tryAgain')}</a>.
          </p>
        </div>
      ) : (
        <form className={s.form} onSubmit={submit} noValidate>
          <span className="eyebrow">{t('pub.signup.eyebrow')}</span>
          <h1 style={{ fontSize: 28 }}>{t('pub.signup.title')}</h1>
          <p className={s.fine}>{t('pub.signup.free')}</p>
          <TextField label={t('pub.signup.orgName')} name="organization" autoComplete="organization" required value={form.org_name} onChange={set('org_name')} />
          <TextField label={t('pub.signup.yourName')} name="name" autoComplete="name" required value={form.display_name} onChange={set('display_name')} />
          <TextField label={t('login.email')} type="email" name="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          <TextField
            label={t('login.password')}
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={set('password')}
            error={passwordShort ? t('password.tooShort') : null}
          />
          <Checkbox
            label={
              <>
                {t('pub.signup.acceptBefore')} <DocLink href={TERMS_URL}>{t('pub.signup.terms')}</DocLink> {t('pub.signup.and')}{' '}
                <DocLink href={DPA_URL}>{t('pub.signup.dpa')}</DocLink> {t('pub.signup.acceptAfter')}
              </>
            }
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            required
          />
          <ActionError error={action.error} />
          <Button
            type="submit"
            variant="primary"
            disabled={action.busy || !accepted || !form.org_name || !form.display_name || !form.email || form.password.length < 12}
          >
            {action.busy ? t('email.sending') : t('pub.signup.submit')}
          </Button>
          <p className={s.fine}>
            {t('pub.signup.haveAccount')} <a href="/login">{t('pub.signup.signIn')}</a>
          </p>
        </form>
      )}
    </AuthFrame>
  );
}
