'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { LOCALE_LABELS, LOCALES, type AppLocale } from '@rd/contracts';
import { RecoveryCodes } from '@/components/auth/RecoveryCodes';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, formActionsClass, formGridClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { announceNotificationsChanged } from '@/lib/events';
import { t } from '@/lib/i18n';
import { browserLocale } from '@/lib/locale';
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
    <Card title={t('profile.title')} subtitle={t('profile.subtitle')}>
      <form onSubmit={submit} className={s.form} noValidate>
        <div className={formGridClass}>
          <TextField label={t('profile.name')} required value={name} onChange={(e) => setName(e.target.value)} error={name.trim() ? null : t('profile.nameMissing')} />
          <SelectField label={t('profile.timeZone')} value={tz} onChange={(e) => setTz(e.target.value)}>
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
            {saved && !dirty ? t('profile.saved') : ''}
          </span>
          <Button type="submit" variant="primary" disabled={!dirty || !name.trim() || action.busy}>
            {action.busy ? t('common.saving') : t('profile.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The local currency, so the preview shows money the way people there usually see it. */
const PREVIEW_CURRENCY: Record<AppLocale, string> = { 'en-US': 'USD', 'en-CA': 'CAD', 'en-GB': 'GBP', 'en-AU': 'AUD', 'en-IN': 'INR', 'fr-CA': 'CAD', 'fr-FR': 'EUR' };

/** A date, time, amount and number written the way `locale` writes them. */
function localePreview(locale: AppLocale): Record<'date' | 'time' | 'money' | 'number', string> {
  const d = new Date();
  return {
    date: new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d),
    time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d),
    money: new Intl.NumberFormat(locale, { style: 'currency', currency: PREVIEW_CURRENCY[locale] }).format(1234.5),
    number: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(7.25),
  };
}

/** The person's language and formats (G27); empty follows the organization, then the browser. */
export function LanguageCard() {
  const { me } = useMe();
  const [choice, setChoice] = useState<AppLocale | ''>(me.user.locale ?? '');
  const action = useAction();
  const fallback = me.organization.locale ?? browserLocale();
  const effective = choice || fallback;
  const p = localePreview(effective);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    // Every label and date on the page changes, so start the page again in the new language.
    if (await action.run(() => rd.account.update({ locale: choice || null }))) window.location.reload();
  };
  return (
    <Card title={t('language.title')} subtitle={t('language.subtitle')}>
      <form onSubmit={save} className={s.form} noValidate>
        <SelectField label={t('language.label')} value={choice} onChange={(e) => setChoice(e.target.value as AppLocale | '')}>
          <option value="">
            {me.organization.locale ? t('language.followOrg', { name: LOCALE_LABELS[fallback] }) : t('language.followBrowser', { name: LOCALE_LABELS[fallback] })}
          </option>
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </SelectField>
        <p className="small secondary" lang={effective}>
          {t('language.preview', p)}
        </p>
        {effective.startsWith('fr') ? <p className="small secondary">{t('language.partial')}</p> : null}
        <ActionError error={action.error} />
        <div className={formActionsClass}>
          <span />
          <Button type="submit" variant="primary" disabled={(choice || null) === me.user.locale || action.busy}>
            {action.busy ? t('common.saving') : t('language.save')}
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
        <TextField label={t('password.current')} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField
          label={t('password.new')}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={next.length > 0 && next.length < 12 ? t('password.tooShort') : null}
        />
        <TextField
          label={t('password.again')}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={again.length > 0 && again !== next ? t('password.mismatch') : null}
        />
      </div>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={onDone}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!valid || action.busy}>
          {action.busy ? t('common.saving') : t('security.changePassword')}
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
        <TextField label={t('email.new')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label={t('password.current')} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button onClick={() => onDone('')}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!email.includes('@') || !password || action.busy}>
          {action.busy ? t('email.sending') : t('email.send')}
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
    <Card title={t('security.title')} subtitle={t('security.subtitle')}>
      {sec.error ? <ErrorState error={sec.error} onRetry={sec.reload} /> : null}
      {!sec.data && !sec.error ? <Loading label={t('security.loading')} /> : null}
      {note ? (
        <p role="status" className={s.note}>
          {note}
        </p>
      ) : null}
      {sec.data ? (
        <dl className={s.rows}>
          <div className={s.row}>
            <dt>{t('security.email')}</dt>
            <dd>
              <span>{me.user.email}</span>
              {sec.data.pending_email ? <span className="small secondary">{t('security.pendingEmail', { email: sec.data.pending_email })}</span> : null}
            </dd>
            <dd className={s.rowAction}>
              {open !== 'email' ? (
                <Button size="sm" variant="quiet" onClick={() => setOpen('email')}>
                  {t('security.changeEmail')}
                </Button>
              ) : null}
            </dd>
          </div>
          {open === 'email' ? (
            <EmailForm
              onDone={(to) => {
                setOpen(null);
                if (to) {
                  setNote(t('security.checkEmail', { email: to }));
                  sec.reload();
                }
              }}
            />
          ) : null}
          <div className={s.row}>
            <dt>{t('security.password')}</dt>
            <dd className="secondary">{t('security.passwordHint')}</dd>
            <dd className={s.rowAction}>
              {open !== 'password' ? (
                <Button size="sm" variant="quiet" onClick={() => setOpen('password')}>
                  {t('security.changePassword')}
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
            <dt>{t('security.twoStep')}</dt>
            <dd>
              {sec.data.mfa_enabled ? (
                <>
                  <Badge tone="solid">{t('security.on')}</Badge>{' '}
                  <span className="small secondary">
                    {t('security.codesLeft', { n: sec.data.recovery_codes_left })}
                    {sec.data.recovery_codes_left <= 3 ? t('security.codesSoon') : ''}
                  </span>
                </>
              ) : (
                <span className="secondary">{t('security.off')}</span>
              )}
            </dd>
            <dd className={s.rowAction}>
              {sec.data.mfa_enabled ? (
                <Button size="sm" variant="quiet" disabled={codesAction.busy} onClick={() => void newCodes()}>
                  {t('security.newCodes')}
                </Button>
              ) : (
                <Link href="/login/mfa?enroll=1&reason=choice&next=%2Fme%2Fsettings">{t('security.setUp')}</Link>
              )}
            </dd>
          </div>
          <ActionError error={codesAction.error} />
          <div className={s.row}>
            <dt>{t('security.others')}</dt>
            <dd className="secondary">
              {sec.data.other_sessions === 0
                ? t('security.onlyThis')
                : t(sec.data.other_sessions === 1 ? 'security.otherCount.one' : 'security.otherCount.other', { n: sec.data.other_sessions })}
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
                      setNote(t(r.signed_out === 1 ? 'security.signedOut.one' : 'security.signedOut.other', { n: r.signed_out }));
                      sec.reload();
                    }
                  }}
                >
                  {t('security.signOutOthers')}
                </Button>
              ) : null}
            </dd>
          </div>
          <ActionError error={others.error} />
        </dl>
      ) : null}
      <Dialog open={codes !== null} onClose={() => setCodes(null)} title={t('security.newCodesTitle')} description={t('security.oldCodes')}>
        {codes ? (
          <RecoveryCodes
            codes={codes}
            doneLabel={t('security.done')}
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
