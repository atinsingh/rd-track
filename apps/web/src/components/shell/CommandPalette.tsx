'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { rd } from '@/lib/api';
import { cx } from '@/lib/cx';
import { tPlural, useT } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import type { NavGroup } from '@/lib/nav';
import { paletteItems, paletteSections, searchPalette } from '@/lib/palette';
import { useApi } from '@/lib/useApi';
import s from './palette.module.css';

/**
 * ⌘K: jump to any page, person or project the user can already open. A combobox
 * over a listbox (WAI-ARIA APG): focus stays in the input, arrows move the option.
 */
export function CommandPalette({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: NavGroup[] }) {
  const { access } = useMe();
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const listId = useId();
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Fetched the first time the palette opens, then kept.
  const [wanted, setWanted] = useState(false);
  if (open && !wanted) setWanted(true);
  const needsDirectory = access.managesTeams || access.managesProjects;
  const directory = useApi(wanted && needsDirectory ? 'palette:directory' : null, (signal) => rd.my.directory(signal));

  const items = useMemo(() => paletteItems(groups, directory.data), [groups, directory.data]);
  const results = useMemo(() => searchPalette(items, query), [items, query]);
  // Options in display order, so arrow keys follow what is on screen.
  const ordered = paletteSections().flatMap((sec) => results.filter((r) => r.kind === sec.kind));
  const sections = paletteSections().map((sec) => ({
    ...sec,
    items: ordered.map((item, i) => ({ item, i })).filter(({ item }) => item.kind === sec.kind),
  })).filter((sec) => sec.items.length > 0);
  const current = Math.min(active, Math.max(ordered.length - 1, 0));
  const optionId = (i: number) => `${listId}-o${i}`;

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

  // Back to whatever opened it, however it closed (Escape closes the dialog natively).
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  });

  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (ordered.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + ordered.length) % ordered.length);
    } else if (e.key === 'Home' && e.ctrlKey) {
      setActive(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      setActive(ordered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = ordered[current];
      if (hit) go(hit.href);
    }
  };

  return (
    <dialog
      ref={ref}
      className={s.palette}
      aria-label={t('shell.jumpLabel')}
      onClose={() => {
        if (open) close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      {open ? (
        <div className={s.inner}>
          <div className={s.searchRow}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              className={s.input}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={ordered.length ? optionId(current) : undefined}
              aria-label={t('palette.searchAll')}
              placeholder={needsDirectory ? t('palette.searchAll') : t('palette.searchPages')}
              value={query}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <kbd className={s.esc}>Esc</kbd>
          </div>
          <div id={listId} role="listbox" aria-label={t('palette.results')} className={s.list}>
            {sections.map((sec) => (
              <div key={sec.kind} role="group" aria-labelledby={`${listId}-${sec.kind}`} className={s.section}>
                <div id={`${listId}-${sec.kind}`} className={s.sectionLabel} role="presentation">
                  {sec.label}
                </div>
                {sec.items.map(({ item, i }) => {
                  return (
                    <div
                      key={item.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === current}
                      className={cx(s.option, i === current && s.optionActive)}
                      onMouseMove={() => {
                        if (i !== current) setActive(i);
                      }}
                      onClick={() => go(item.href)}
                    >
                      <span className={s.optionLabel}>{item.label}</span>
                      <span className={s.optionHint}>{item.hint}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {ordered.length === 0 ? (
            <p className={s.empty}>
              {t('palette.nothing', { query: query.trim() })} {needsDirectory ? t('palette.peopleHint') : t('palette.pagesHint')}
            </p>
          ) : null}
          {directory.error ? <p className={s.note}>{t('palette.directoryFailed')}</p> : null}
          <p className="visually-hidden" aria-live="polite">
            {query.trim() ? tPlural(ordered.length, 'palette.count.one', 'palette.count.other') : ''}
          </p>
          <div className={s.foot} aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> {t('palette.move')}
            </span>
            <span>
              <kbd>↵</kbd> {t('palette.open')}
            </span>
            <span>
              <kbd>Esc</kbd> {t('palette.close')}
            </span>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
