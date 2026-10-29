'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { useT } from '@/lib/i18n';
import s from './dialog.module.css';

/**
 * Modal dialog on the native <dialog> element: the browser makes the rest of the
 * page inert, traps focus and closes on Escape. Focus returns to the element that
 * opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'modal',
  tone = 'light',
  size = 'md',
  eyebrow,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: 'modal' | 'sheet';
  tone?: 'light' | 'ink';
  size?: 'sm' | 'md' | 'lg';
  eyebrow?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      opener.current = document.activeElement;
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const el = opener.current;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx(s.dialog, variant === 'sheet' && s.sheet, tone === 'ink' && s.ink, s[size])}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop (outside the content box) closes.
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className={s.inner}>
          <div className={s.head}>
            <div className={s.headText}>
              {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
              <h2 id={titleId}>{title}</h2>
              {description ? (
                <p id={descId} className={s.desc}>
                  {description}
                </p>
              ) : null}
            </div>
            <button type="button" className={s.close} onClick={onClose} aria-label={t('common.close')}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
          </div>
          <div className={s.body}>{children}</div>
          {footer ? <div className={s.footer}>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
