'use client';

import { useState } from 'react';
import { Button, type ButtonVariant } from '@/components/ui/Button';

export function CopyButton({ text, label = 'Copy', variant = 'quiet' }: { text: string; label?: string; variant?: ButtonVariant }) {
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
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select the text' : label}
    </Button>
  );
}
