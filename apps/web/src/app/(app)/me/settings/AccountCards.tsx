'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { RecoveryCodes } from '@/components/auth/RecoveryCodes';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, formActionsClass, formGridClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { announceNotificationsChanged } from '@/lib/events';
import { useMe } from '@/lib/me';
import { timeZoneOptions } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from './settings.module.css';

/** Name and time zone: what managers see, and how days and weeks are cut. */
export function ProfileCard() {
  const { me, reload } = useMe();
  const [name, setName] = useState(me.user.display_name);
  const [tz, setTz] = useState(me.user.timezone);
  const [saved, setSaved] = useState(false);
  const zones = useMemo(() => timeZoneOptions(me.user.timezone), [me.user.timezone]);
  const action = useAction();
  const dirty = name.trim() !== me.user.display_name || tz !== me.user.timezone;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await action.run(() => rd.account.update({ display_name: name.trim(), timezone: tz }))) {
      setSaved(true);
      reload();
    }
  };
  return (
    <Card title="Profile" subtitle="Your time zone decides where your days and weeks start, in reports and timesheets.">
      <form onSubmit={submit} className={s.form} noValidate>
        <div className={formGridClass}>
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} error={name.trim() ? null : 'Enter your name.'} />
          <SelectField label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </SelectField>
        </div>
        <ActionError error={action.error} />
        <div className={formActionsClass}>
          <span role="status" className="small secondary">
            {saved && !dirty ? 'Saved.' : ''}
          </span>
          <Button type="submit" variant="primary" disabled={!dirty || !name.trim() || action.busy}>
            {action.busy ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const action = useAction();
  const valid = current && next.length >= 12 && next === again;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (valid && (await action.run(() => rd.account.changePassword(current, next)))) {
      announceNotificationsChanged();
      onDone();
    }
  };
  return (
    <form onSubmit={submit} className={s.form} noValidate>
      <div className={formGridClass}>
        <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={next.length > 0 && next.length < 12 ? 'Use at least 12 characters.' : null}
        />
        <TextField
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={again.length > 0 && again !== next ? 'The passwords don’t match.' : null}
        />
      </div>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!valid || action.busy}>
          {action.busy ? 'Saving…' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}

function EmailForm({ onDone }: { onDone: (to: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => rd.account.changeEmail(email.trim(), password))) onDone(email.trim());
  };
  return (
    <form onSubmit={submit} className={s.form} noValidate>
      <div className={formGridClass}>
        <TextField label="New email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => onDone('')}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!email.includes('@') || !password || action.busy}>
          {action.busy ? 'Sending…' : 'Send confirmation'}
        </Button>
      </div>
    </form>
  );
}

/** Email, password, two-step sign-in and other sessions. */
export function SecurityCard() {
  const { me } = useMe();
  const sec = useApi('me:security', (signal) => rd.account.security(signal));
  const [open, setOpen] = useState<'password' | 'email' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const codesAction = useAction();
  const others = useAction();

  const newCodes = async () => {
    const r = await codesAction.run(() => rd.account.newRecoveryCodes());
    if (r) setCodes(r.recovery_codes);
  };

  return (
    <Card title="Sign-in and security" subtitle="Changes here send you a security notice by email, so you know if it wasn’t you.">
      {sec.error ? <ErrorState error={sec.error} onRetry={sec.reload} /> : null}
      {!sec.data && !sec.error ? <Loading label="Loading your sign-in settings" /> : null}
      {note ? (
        <p role="status" className={s.note}>
          {note}
        </p>
      ) : null}
      {sec.data ? (
        <dl className={s.rows}>
          <div className={s.row}>
            <dt>Email</dt>
            <dd>
              <span>{me.user.email}</span>
              {sec.data.pending_email ? <span className="small secondary"> · waiting for {sec.data.pending_email} to confirm</span> : null}
            </dd>
            <dd className={s.rowAction}>
              {open !== 'email' ? (
                <Button size="sm" variant="quiet" onClick={() => setOpen('email')}>
                  Change email
                </Button>
              ) : null}
            </dd>
          </div>
          {open === 'email' ? (
            <EmailForm
              onDone={(to) => {
                setOpen(null);
                if (to) {
                  setNote(`Check ${to} for a confirmation link. Your email doesn’t change until you open it.`);
                  sec.reload();
                }
              }}
            />
          ) : null}
          <div className={s.row}>
            <dt>Password</dt>
            <dd className="secondary">Choose a long one you don’t use anywhere else.</dd>
            <dd className={s.rowAction}>
              {open !== 'password' ? (
                <Button size="sm" variant="quiet" onClick={() => setOpen('password')}>
                  Change password
                </Button>
              ) : null}
            </dd>
          </div>
          {open === 'password' ? (
            <PasswordForm
              onDone={() => {
                setOpen(null);
                sec.reload();
              }}
            />
          ) : null}
          <div className={s.row}>
            <dt>Two-step sign-in</dt>
            <dd>
              {sec.data.mfa_enabled ? (
                <>
                  <Badge tone="solid">On</Badge>{' '}
                  <span className="small secondary">
                    {sec.data.recovery_codes_left} of 10 recovery codes left{sec.data.recovery_codes_left <= 3 ? ' — create new ones soon' : ''}
                  </span>
                </>
              ) : (
                <span className="secondary">Off — a code from an authenticator app keeps your account safe even if your password leaks.</span>
              )}
            </dd>
            <dd className={s.rowAction}>
              {sec.data.mfa_enabled ? (
                <Button size="sm" variant="quiet" disabled={codesAction.busy} onClick={() => void newCodes()}>
                  New recovery codes
                </Button>
              ) : (
                <Link href="/login/mfa?enroll=1&reason=choice&next=%2Fme%2Fsettings">Set up →</Link>
              )}
            </dd>
          </div>
          <ActionError error={codesAction.error} />
          <div className={s.row}>
            <dt>Other sign-ins</dt>
            <dd className="secondary">
              {sec.data.other_sessions === 0 ? 'Only this browser.' : `${sec.data.other_sessions} other ${sec.data.other_sessions === 1 ? 'browser or computer' : 'browsers or computers'}.`}
            </dd>
            <dd className={s.rowAction}>
              {sec.data.other_sessions > 0 ? (
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={others.busy}
                  onClick={async () => {
                    const r = await others.run(() => rd.account.signOutOthers());
                    if (r) {
                      setNote(`Signed out of ${r.signed_out} other ${r.signed_out === 1 ? 'session' : 'sessions'}.`);
                      sec.reload();
                    }
                  }}
                >
                  Sign out everywhere else
                </Button>
              ) : null}
            </dd>
          </div>
          <ActionError error={others.error} />
        </dl>
      ) : null}
      <Dialog open={codes !== null} onClose={() => setCodes(null)} title="Your new recovery codes" description="The old codes no longer work.">
        {codes ? (
          <RecoveryCodes
            codes={codes}
            doneLabel="Done"
            onDone={() => {
              setCodes(null);
              sec.reload();
            }}
          />
        ) : null}
      </Dialog>
    </Card>
  );
}
