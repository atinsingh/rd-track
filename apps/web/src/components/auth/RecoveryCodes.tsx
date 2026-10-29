'use client';

import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import s from './recovery.module.css';

/**
 * One-time recovery codes, shown once. The person confirms they saved them before moving
 * on, because nobody (including Track) can show them again.
 */
export function RecoveryCodes({ codes, doneLabel, onDone }: { codes: string[]; doneLabel: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = `RoundDigital Track recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'rounddigital-track-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className={s.wrap}>
      <p className="secondary">
        If you lose your phone, each of these codes signs you in once instead of the app. They are shown only now; store them in a
        password manager or print them.
      </p>
      <ul className={s.codes} aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="mono">
            {c}
          </li>
        ))}
      </ul>
      <div className={s.actions}>
        <CopyButton text={codes.join('\n')} label="Copy codes" />
        <Button variant="quiet" onClick={download}>
          Download .txt
        </Button>
      </div>
      <Checkbox label="I’ve saved these codes somewhere safe" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
      <Button variant="primary" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
