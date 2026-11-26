'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { PENDING_TZ_KEY, browserTimeZone } from '@/lib/time';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../../login/AuthFrame';
import s from '../../login/login.module.css';

/**
 * The link from the confirmation email lands here. Nothing is sent until the form is
 * submitted, so opening the link (or a mail scanner following it) doesn't use it up.
 */
function Verify() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const t = useT();
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [tried, setTried] = useState(false);
  const action = useAction();

  const nameError = name.trim() ? null : t('pub.verify.nameRequired');
  const orgError = org.trim().length >= 2 ? null : t('pub.verify.orgRequired');
  const badLink = !token || action.error?.code === 'signup_link_invalid';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!token || nameError || orgError) return;
    const r = await action.run(() => rd.auth.verifySignup({ token, display_name: name.trim(), org_name: org.trim() }));
    if (!r) return;
    // The account starts on UTC; the founder's browser zone is the right default for them and,
    // through them, for the people and policies they set up next. They can change it in Settings.
    // Saved by the signed-in app once the session may write (after two-factor setup, where required).
    try {
      window.sessionStorage.setItem(PENDING_TZ_KEY, browserTimeZone());
    } catch {
      // Blocked storage: they keep UTC until they change it in Settings.
    }
    router.replace('/admin/billing');
  };

  if (badLink) {
    return (
      <div className={s.form} role="alert">
        <span className="eyebrow">{t('pub.verify.eyebrow')}</span>
        <h1 className={s.title}>{t('pub.verify.badTitle')}</h1>
        <p>{token ? t('pub.verify.badLink') : t('pub.verify.missingToken')}</p>
        <p className={s.alt}>
          <a href="/signup">{t('pub.verify.signUpAgain')}</a> {t('pub.verify.or')} <a href="/login">{t('pub.verify.signIn')}</a>.
        </p>
      </div>
    );
  }
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <span className="eyebrow">{t('pub.verify.detailsEyebrow')}</span>
      <h1 className={s.title}>{t('pub.verify.detailsTitle')}</h1>
      <p className={s.lede}>{t('pub.verify.detailsNote')}</p>
      <TextField
        label={t('pub.signup.yourName')}
        name="name"
        autoComplete="name"
        autoFocus
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={tried ? nameError : null}
      />
      <TextField
        label={t('pub.signup.orgName')}
        name="organization"
        autoComplete="organization"
        required
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        hint={t('pub.verify.orgHint')}
        error={tried ? orgError : null}
      />
      <ActionError error={action.error} />
      <Button type="submit" variant="primary" disabled={action.busy}>
        {action.busy ? t('pub.verify.creating') : t('pub.verify.submit')}
      </Button>
    </form>
  );
}

export default function VerifyPage() {
  return (
    <AuthFrame>
      <Suspense>
        <Verify />
      </Suspense>
    </AuthFrame>
  );
}
