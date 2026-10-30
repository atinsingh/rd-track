'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

/** Confirms a new sign-in address; a button rather than on load, so link scanners can't confirm it. */
function Confirm() {
  const token = useSearchParams().get('token') ?? '';
  const action = useAction();
  const t = useT();
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <div className={s.form} role="status">
        <span className="eyebrow">{t('pub.emailChange.doneEyebrow')}</span>
        <h1 style={{ fontSize: 28 }}>{t('pub.emailChange.doneTitle')}</h1>
        <p>{t('pub.emailChange.doneBody')}</p>
        <a className={s.primaryLink} href="/login">
          {t('login.submit')}
        </a>
      </div>
    );
  }
  return (
    <div className={s.form}>
      <span className="eyebrow">{t('pub.verify.eyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('pub.emailChange.title')}</h1>
      <p className="secondary">{t('pub.emailChange.body')}</p>
      <ActionError error={action.error} />
      <Button variant="primary" disabled={!token || action.busy} onClick={async () => setDone(Boolean(await action.run(() => rd.auth.confirmEmailChange(token))))}>
        {action.busy ? t('pub.emailChange.confirming') : t('pub.emailChange.confirm')}
      </Button>
    </div>
  );
}

export default function EmailChangePage() {
  return (
    <AuthFrame>
      <Suspense>
        <Confirm />
      </Suspense>
    </AuthFrame>
  );
}
