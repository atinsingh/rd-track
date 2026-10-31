'use client';

import { useState } from 'react';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { useT } from '@/lib/i18n';

export function CopyButton({ text, label, variant = 'quiet' }: { text: string; label?: string; variant?: ButtonVariant }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2500);
  };
  return (
    <Button variant={variant} onClick={copy} aria-live="polite">
      {state === 'copied' ? t('copy.copied') : state === 'failed' ? t('copy.failed') : (label ?? t('copy.copy'))}
    </Button>
  );
}
