'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { rd } from '@/lib/api';
import { useAction } from '@/lib/useApi';
import { AuthFrame } from '../login/AuthFrame';
import s from '../login/login.module.css';

export default function SignupPage() {
  const [form, setForm] = useState({ org_name: '', display_name: '', email: '', password: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const action = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const passwordShort = form.password.length > 0 && form.password.length < 12;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => rd.auth.signup({ ...form, email: form.email.trim() }));
    if (r) setSentTo(form.email.trim());
  };

  return (
    <AuthFrame>
      {sentTo ? (
        <div className={s.form} role="status">
          <span className="eyebrow">Track · Check your email</span>
          <h1 style={{ fontSize: 28 }}>Confirm your email</h1>
          <p>
            We sent a link to <strong>{sentTo}</strong>. Open it within 24 hours to create your organization and start a
            14-day Pro trial.
          </p>
          <p className={s.fine}>Nothing arrived? Check spam, or <a href="/signup">try again</a>.</p>
        </div>
      ) : (
        <form className={s.form} onSubmit={submit} noValidate>
          <span className="eyebrow">Track · Create an organization</span>
          <h1 style={{ fontSize: 28 }}>Start free</h1>
          <p className={s.fine}>Free for up to 2 people. Every new organization gets a 14-day Pro trial — no card needed.</p>
          <TextField label="Organization name" name="organization" autoComplete="organization" required value={form.org_name} onChange={set('org_name')} />
          <TextField label="Your name" name="name" autoComplete="name" required value={form.display_name} onChange={set('display_name')} />
          <TextField label="Work email" type="email" name="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          <TextField
            label="Password"
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={set('password')}
            error={passwordShort ? 'Use at least 12 characters.' : null}
          />
          <ActionError error={action.error} />
          <Button
            type="submit"
            variant="primary"
            disabled={action.busy || !form.org_name || !form.display_name || !form.email || form.password.length < 12}
          >
            {action.busy ? 'Sending…' : 'Create organization →'}
          </Button>
          <p className={s.fine}>
            Already have an account? <a href="/login">Sign in</a>
          </p>
        </form>
      )}
    </AuthFrame>
  );
}
