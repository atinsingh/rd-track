'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { RecoveryCodes } from '@/components/auth/RecoveryCodes';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useAction, useApi } from '@/lib/useApi';
import { AuthFrame, safeNext } from '../AuthFrame';
import s from '../login.module.css';

function CodeForm({ label, onSubmit, busy, submitLabel }: { label: string; onSubmit: (code: string) => void; busy: boolean; submitLabel: string }) {
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
        hint="6 digits from your authenticator app"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        className="mono"
      />
      <Button type="submit" variant="primary" disabled={busy || !valid}>
        {busy ? 'Checking…' : submitLabel}
      </Button>
    </form>
  );
}

function RecoveryForm({ next, onBack }: { next: string; onBack: () => void }) {
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
      <span className="eyebrow">Track · Two-factor</span>
      <h1 style={{ fontSize: 28 }}>Use a recovery code</h1>
      <p className="secondary">Each code from the list you saved works once. Afterwards, create new codes in Settings.</p>
      <form className={s.form} onSubmit={submit} noValidate>
        <TextField
          label="Recovery code"
          name="recovery-code"
          autoComplete="one-time-code"
          spellCheck={false}
          required
          hint="Like k7m2-9qxd"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="mono"
        />
        <Button type="submit" variant="primary" disabled={action.busy || !valid}>
          {action.busy ? 'Checking…' : 'Sign in →'}
        </Button>
      </form>
      <ActionError error={action.error} />
      <p className={s.fine}>
        <button type="button" className={s.linkButton} onClick={onBack}>
          Use the authenticator app instead
        </button>{' '}
        · No codes left? Ask another org admin to reset your two-factor sign-in.
      </p>
    </>
  );
}

function Verify({ next }: { next: string }) {
  const action = useAction();
  const [recovery, setRecovery] = useState(false);
  const verify = async (code: string) => {
    const ok = await action.run(() => rd.auth.mfaVerify(code));
    if (ok) window.location.assign(next);
  };
  if (recovery) return <RecoveryForm next={next} onBack={() => setRecovery(false)} />;
  return (
    <>
      <span className="eyebrow">Track · Two-factor</span>
      <h1 style={{ fontSize: 28 }}>Confirm it&apos;s you</h1>
      <p className="secondary">Open your authenticator app and enter the current code for RoundDigital Track.</p>
      <CodeForm label="Verification code" submitLabel="Verify →" busy={action.busy} onSubmit={verify} />
      <ActionError error={action.error} />
      <p className={s.fine}>
        Lost your phone?{' '}
        <button type="button" className={s.linkButton} onClick={() => setRecovery(true)}>
          Use a recovery code
        </button>
      </p>
    </>
  );
}

function Enroll({ next, chosen = false }: { next: string; chosen?: boolean }) {
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
        <span className="eyebrow">Track · Two-factor is on</span>
        <h1 style={{ fontSize: 28 }}>Save your recovery codes</h1>
        <RecoveryCodes codes={codes} doneLabel="Continue →" onDone={() => window.location.assign(next)} />
      </>
    );
  }
  return (
    <>
      <span className="eyebrow">Track · Set up two-factor</span>
      <h1 style={{ fontSize: 28 }}>Set up two-factor sign-in</h1>
      <p className="secondary">
        {chosen
          ? 'A code from your authenticator app, as well as your password, keeps your account safe even if the password leaks.'
          : 'Your role can change policies and people, so it needs a second factor.'}
      </p>
      {enroll.error ? (
        <ErrorState error={enroll.error} onRetry={enroll.reload} />
      ) : !enroll.data ? (
        <Loading label="Creating your secret" />
      ) : (
        <>
          <ol className={s.steps}>
            <li>In your authenticator app, add an account by entering this key:</li>
          </ol>
          <div className={s.secret} aria-label="Secret key">
            {enroll.data.secret_base32.replace(/(.{4})/g, '$1 ').trim()}
          </div>
          <p className={s.fine}>Or paste this setup link into an app that accepts otpauth links:</p>
          <div className={s.otpauth}>{enroll.data.otpauth_url}</div>
          <ol className={s.steps} start={2}>
            <li>Enter the 6-digit code it shows to finish.</li>
          </ol>
          <CodeForm label="Code from your app" submitLabel="Turn on two-factor →" busy={action.busy} onSubmit={confirm} />
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
  // Without the hint from login, ask the API whether this user already has MFA.
  const me = useApi(forcedEnroll ? null : 'mfa-me', (signal) => rd.me({ signal, redirectOnAuth: false }));

  if (forcedEnroll) return <Enroll next={next} chosen={params.get('reason') === 'choice'} />;
  if (me.error?.code === 'unauthenticated') {
    return (
      <>
        <h1 style={{ fontSize: 28 }}>Sign in first</h1>
        <p className="secondary">
          Your session has ended. <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in again</Link>.
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
