'use client';

import { useId, useMemo, useRef } from 'react';
import { InlineSelect } from '@/components/ui/Field';
import { addDays, formatDayLabel, timeZoneOptions } from '@/lib/time';
import { t } from '@/lib/i18n';
import s from './day.module.css';

/** ‹ date › plus time zone, for day and week views. */
export function DateSwitcher({
  date,
  onDate,
  tz,
  onTz,
  step = 1,
  unit = 'day',
  max,
  label,
}: {
  date: string;
  onDate: (d: string) => void;
  tz: string;
  onTz?: (tz: string) => void;
  step?: number;
  unit?: 'day' | 'week';
  /** latest selectable date (e.g. today) */
  max?: string;
  /** text shown for the period, defaults to the date */
  label?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const el = inputRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  const zones = useMemo(() => timeZoneOptions(tz), [tz]);
  const nextDate = addDays(date, step);
  const nextDisabled = max !== undefined && nextDate > max;
  return (
    <div className={s.switcher}>
      <button type="button" className={s.stepBtn} aria-label={unit === 'day' ? t('date.previousDay') : t('date.previousWeek')} onClick={() => onDate(addDays(date, -step))}>
        ‹
      </button>
      <span className={s.dateBox}>
        <span aria-live="polite">{label ?? formatDayLabel(date)}</span>
        <label htmlFor={id} className="visually-hidden">
          {unit === 'day' ? t('date.chooseDate') : t('date.chooseWeekDay')}
        </label>
        <input
          id={id}
          ref={inputRef}
          type="date"
          className="visually-hidden"
          value={date}
          max={max}
          onChange={(e) => e.target.value && onDate(e.target.value)}
        />
        <button type="button" className={s.calBtn} tabIndex={-1} aria-hidden="true" onClick={openPicker}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="3" width="12" height="11" />
            <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
          </svg>
        </button>
      </span>
      <button
        type="button"
        className={s.stepBtn}
        aria-label={unit === 'day' ? t('date.nextDay') : t('date.nextWeek')}
        disabled={nextDisabled}
        onClick={() => onDate(nextDate)}
      >
        ›
      </button>
      {onTz ? (
        <InlineSelect label={t('date.timeZone')} value={tz} onChange={(e) => onTz(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </InlineSelect>
      ) : null}
    </div>
  );
}
