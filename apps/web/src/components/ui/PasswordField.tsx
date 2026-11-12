'use client';

import { useState, type ComponentProps } from 'react';
import { useT } from '@/lib/i18n';
import { TextField } from './Field';
import s from './ui.module.css';

/** A password input with a show/hide control, so a typo can be seen before it's submitted. */
export function PasswordField(props: Omit<ComponentProps<typeof TextField>, 'type' | 'trailing'>) {
  const [shown, setShown] = useState(false);
  const t = useT();
  return (
    <TextField
      {...props}
      type={shown ? 'text' : 'password'}
      trailing={
        <button type="button" className={s.reveal} aria-pressed={shown} aria-label={t('password.reveal')} onClick={() => setShown((v) => !v)}>
          {shown ? t('password.hide') : t('password.show')}
        </button>
      }
    />
  );
}
