'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { RecoveryCodes } from '@/components/auth/RecoveryCodes';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useAction, useApi } from '@/lib/useApi';
import { AuthFrame, safeNext } from '../AuthFrame';
import s from '../login.module.css';

function CodeForm({ label, onSubmit, busy, submitLabel }: { label: string; onSubmit: (code: string) => void; busy: boolean; submitLabel: string }) {
  const t = useT();
  const [code, setCode] = useState('');
  const valid = /^\d{6}$/.test(code);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(code);
  };
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <TextField
        label={label}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        hint={t('mfa.codeHint')}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        className="mono"
      />
      <Button type="submit" variant="primary" disabled={busy || !valid}>
        {busy ? t('mfa.checking') : submitLabel}
      </Button>
    </form>
  );
}

function RecoveryForm({ next, onBack }: { next: string; onBack: () => void }) {
  const t = useT();
  const action = useAction();
  const [code, setCode] = useState('');
  const valid = /^[a-z2-9]{4}-[a-z2-9]{4}$/i.test(code.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const ok = await action.run(() => rd.auth.mfaRecovery(code.trim().toLowerCase()));
    if (ok) window.location.assign(next);
  };
  return (
    <>
      <span className="eyebrow">{t('mfa.eyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('mfa.recoveryTitle')}</h1>
      <p className="secondary">{t('mfa.recoveryIntro')}</p>
      <form className={s.form} onSubmit={submit} noValidate>
        <TextField
          label={t('mfa.recoveryCode')}
          name="recovery-code"
          autoComplete="one-time-code"
          spellCheck={false}
          required
          hint={t('mfa.recoveryHint')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="mono"
        />
        <Button type="submit" variant="primary" disabled={action.busy || !valid}>
          {action.busy ? t('mfa.checking') : t('login.submit')}
        </Button>
      </form>
      <ActionError error={action.error} />
      <p className={s.fine}>
        <button type="button" className={s.linkButton} onClick={onBack}>
          {t('mfa.useApp')}
        </button>{' '}
        · {t('mfa.noCodes')}
      </p>
    </>
  );
}

function Verify({ next }: { next: string }) {
  const t = useT();
  const action = useAction();
  const [recovery, setRecovery] = useState(false);
  const verify = async (code: string) => {
    const ok = await action.run(() => rd.auth.mfaVerify(code));
    if (ok) window.location.assign(next);
  };
  if (recovery) return <RecoveryForm next={next} onBack={() => setRecovery(false)} />;
  return (
    <>
      <span className="eyebrow">{t('mfa.eyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('mfa.verifyTitle')}</h1>
      <p className="secondary">{t('mfa.verifyIntro')}</p>
      <CodeForm label={t('mfa.verifyLabel')} submitLabel={t('mfa.verify')} busy={action.busy} onSubmit={verify} />
      <ActionError error={action.error} />
      <p className={s.fine}>
        {t('mfa.lostPhone')}{' '}
        <button type="button" className={s.linkButton} onClick={() => setRecovery(true)}>
          {t('mfa.useRecovery')}
        </button>
      </p>
    </>
  );
}

function Enroll({ next, chosen = false }: { next: string; chosen?: boolean }) {
  const t = useT();
  const enroll = useApi('mfa-enroll', () => rd.auth.mfaEnroll());
  const action = useAction();
  const [codes, setCodes] = useState<string[] | null>(null);
  const confirm = async (code: string) => {
    const r = await action.run(() => rd.auth.mfaEnrollConfirm(code));
    if (r) setCodes(r.recovery_codes);
  };
  if (codes) {
    return (
      <>
        <span className="eyebrow">{t('mfa.onEyebrow')}</span>
        <h1 style={{ fontSize: 28 }}>{t('mfa.saveCodesTitle')}</h1>
        <RecoveryCodes codes={codes} doneLabel={t('mfa.continue')} onDone={() => window.location.assign(next)} />
      </>
    );
  }
  return (
    <>
      <span className="eyebrow">{t('mfa.setupEyebrow')}</span>
      <h1 style={{ fontSize: 28 }}>{t('mfa.setupTitle')}</h1>
      <p className="secondary">
        {chosen ? t('mfa.whyChosen') : t('mfa.whyRole')}
      </p>
      {enroll.error ? (
        <ErrorState error={enroll.error} onRetry={enroll.reload} />
      ) : !enroll.data ? (
        <Loading label={t('mfa.creating')} />
      ) : (
        <>
          <ol className={s.steps}>
            <li>{t('mfa.step1')}</li>
          </ol>
          <div className={s.secret} aria-label={t('mfa.secretKey')}>
            {enroll.data.secret_base32.replace(/(.{4})/g, '$1 ').trim()}
          </div>
          <p className={s.fine}>{t('mfa.otpauth')}</p>
          <div className={s.otpauth}>{enroll.data.otpauth_url}</div>
          <ol className={s.steps} start={2}>
            <li>{t('mfa.step2')}</li>
          </ol>
          <CodeForm label={t('mfa.appCode')} submitLabel={t('mfa.turnOn')} busy={action.busy} onSubmit={confirm} />
          <ActionError error={action.error} />
        </>
      )}
    </>
  );
}

function MfaFlow() {
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const forcedEnroll = params.get('enroll') === '1';
  const t = useT();
  // Without the hint from login, ask the API whether this user already has MFA.
  const me = useApi(forcedEnroll ? null : 'mfa-me', (signal) => rd.me({ signal, redirectOnAuth: false }));

  if (forcedEnroll) return <Enroll next={next} chosen={params.get('reason') === 'choice'} />;
  if (me.error?.code === 'unauthenticated') {
    return (
      <>
        <h1 style={{ fontSize: 28 }}>{t('mfa.signInFirst')}</h1>
        <p className="secondary">
          {t('mfa.sessionEnded')} <Link href={`/login?next=${encodeURIComponent(next)}`}>{t('mfa.signInAgain')}</Link>.
        </p>
      </>
    );
  }
  if (me.data) return me.data.user.mfa_enabled ? <Verify next={next} /> : <Enroll next={next} />;
  // mfa_required or other errors: the session exists but is not verified yet.
  if (me.error) return <Verify next={next} />;
  return <Loading />;
}

export default function MfaPage() {
  return (
    <AuthFrame>
      <Suspense>
        <MfaFlow />
      </Suspense>
    </AuthFrame>
  );
}
