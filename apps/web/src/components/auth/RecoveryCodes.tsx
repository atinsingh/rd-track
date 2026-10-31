'use client';

import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { useT } from '@/lib/i18n';
import s from './recovery.module.css';

/**
 * One-time recovery codes, shown once. The person confirms they saved them before moving
 * on, because nobody (including Track) can show them again.
 */
export function RecoveryCodes({ codes, doneLabel, onDone }: { codes: string[]; doneLabel: string; onDone: () => void }) {
  const t = useT();
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
        {t('recovery.intro')}
      </p>
      <ul className={s.codes} aria-label={t('recovery.list')}>
        {codes.map((c) => (
          <li key={c} className="mono">
            {c}
          </li>
        ))}
      </ul>
      <div className={s.actions}>
        <CopyButton text={codes.join('\n')} label={t('recovery.copy')} />
        <Button variant="quiet" onClick={download}>
          {t('recovery.download')}
        </Button>
      </div>
      <Checkbox label={t('recovery.saved')} checked={saved} onChange={(e) => setSaved(e.target.checked)} />
      <Button variant="primary" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
