'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { CHILD_COLORS, FAMILY_REGIONS, adultOn, type ChildDTO, type ChildTodayDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Meter } from '@/components/ui/Layout';
import type { ChildInput } from '@/lib/api';
import { cx } from '@/lib/cx';
import { CHILD_COLOR_HEX, birthYears, budgetState, minutesLabel } from '@/lib/family';
import { useT } from '@/lib/i18n';
import { formatMonth, formatMonthYear, formatRelative, formatTime } from '@/lib/time';
import { useAction } from '@/lib/useApi';
import s from './family.module.css';

/** The child's colour, as a dot beside their name (never the only way to tell them apart). */
export function ColorDot({ color, size = 12 }: { color: string; size?: number }) {
  return <span className={s.dot} style={{ background: CHILD_COLOR_HEX[color] ?? CHILD_COLOR_HEX.amber, width: size, height: size }} aria-hidden="true" />;
}

/** "12 · Teen" — age, and the teen badge when it applies. */
export function AgeLine({ child }: { child: Pick<ChildDTO, 'age' | 'teen'> }) {
  const t = useT();
  return (
    <span className={s.ageLine}>
      <span>{t('fam.child.age', { age: String(child.age) })}</span>
      {child.teen ? <Badge>{t('fam.child.teen')}</Badge> : null}
    </span>
  );
}

/** Screen time today against the day's budget: a meter plus the same thing in words. */
export function BudgetMeter({ today }: { today: Pick<ChildTodayDTO, 'used_minutes' | 'budget_minutes'> }) {
  const t = useT();
  const b = budgetState(today.used_minutes, today.budget_minutes);
  const used = minutesLabel(today.used_minutes);
  const words =
    today.budget_minutes === null
      ? t('fam.today.usedNoLimit', { used })
      : b.over
        ? t('fam.today.usedOver', { used, budget: minutesLabel(today.budget_minutes) })
        : t('fam.today.usedOf', { used, budget: minutesLabel(today.budget_minutes), left: minutesLabel(b.left ?? 0) });
  return (
    <div className={s.budget}>
      {today.budget_minutes !== null ? (
        <Meter
          value={today.used_minutes}
          max={Math.max(today.budget_minutes, today.used_minutes, 1)}
          mark={today.budget_minutes}
          label={words}
        />
      ) : null}
      <p className={cx('small', b.over ? s.over : 'secondary')}>{words}</p>
    </div>
  );
}

/** The routine in force, the pause, and how many devices are online: one line each. */
export function NowLines({ today, tz }: { today: ChildTodayDTO; tz: string }) {
  const t = useT();
  const online = today.devices.filter((d) => d.online).length;
  return (
    <ul className={s.nowLines}>
      {today.paused_until ? <li>{t('fam.today.paused', { until: formatTime(today.paused_until, tz) })}</li> : null}
      {today.routine_now ? <li>{t('fam.today.routine', { name: today.routine_now.name, until: formatTime(today.routine_now.until, tz) })}</li> : null}
      <li>
        {today.devices.length === 0
          ? t('fam.today.noDevices')
          : t('fam.today.devicesOnline', { online: String(online), total: String(today.devices.length) })}
      </li>
    </ul>
  );
}

/** A device's last check-in, in words. */
export function LastSeen({ at, tz }: { at: string | null; tz: string }) {
  return <>{formatRelative(at, tz)}</>;
}

export const OS_NAME: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS' };

/** Months as the locale names them, for the birth-month picker. */
function monthNames(): string[] {
  return Array.from({ length: 12 }, (_, i) => formatMonth(`2026-${String(i + 1).padStart(2, '0')}-01`));
}

/** The child's profile form, for adding a child and for their Settings tab. */
export function ChildForm({
  initial,
  submitLabel,
  busyLabel,
  onSubmit,
  cancelHref,
}: {
  initial?: ChildInput;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (input: ChildInput) => Promise<unknown>;
  cancelHref?: string;
}) {
  const t = useT();
  const action = useAction();
  const [f, setF] = useState<ChildInput>(initial ?? { display_name: '', birth_year: new Date().getUTCFullYear() - 10, birth_month: 1, region: 'CA', color: 'amber' });
  const months = monthNames();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(() => onSubmit({ ...f, display_name: f.display_name.trim() }));
  };
  const errorText =
    action.error?.code === 'adult' ? t('fam.child.adultError') : action.error?.code === 'family_full' ? t('fam.child.fullError') : null;
  return (
    <form className={s.childForm} onSubmit={submit} noValidate>
      <TextField
        label={t('fam.child.name')}
        hint={t('fam.child.nameHint')}
        required
        maxLength={60}
        autoComplete="off"
        value={f.display_name}
        onChange={(e) => setF({ ...f, display_name: e.target.value })}
      />
      <div className={s.twoCol}>
        <SelectField label={t('fam.child.birthMonth')} value={String(f.birth_month)} onChange={(e) => setF({ ...f, birth_month: Number(e.target.value) })}>
          {months.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('fam.child.birthYear')} value={String(f.birth_year)} onChange={(e) => setF({ ...f, birth_year: Number(e.target.value) })}>
          {birthYears().map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </SelectField>
      </div>
      <p className="small secondary">{t('fam.child.endsAt18', { date: formatMonthYear(adultOn(f.birth_year, f.birth_month)) })}</p>
      <SelectField
        label={t('fam.child.region')}
        hint={t('fam.child.regionHint')}
        value={f.region}
        onChange={(e) => setF({ ...f, region: e.target.value as ChildInput['region'] })}
      >
        {FAMILY_REGIONS.map((r) => (
          <option key={r} value={r}>
            {t(`fam.region.${r}`)}
          </option>
        ))}
      </SelectField>
      <fieldset className={s.colors}>
        <legend className={s.legend}>{t('fam.child.color')}</legend>
        {CHILD_COLORS.map((c) => (
          <label key={c} className={cx(s.colorOption, f.color === c && s.colorOn)}>
            <input type="radio" name="color" value={c} checked={f.color === c} onChange={() => setF({ ...f, color: c })} />
            <ColorDot color={c} size={14} />
            <span>{t(`fam.color.${c}`)}</span>
          </label>
        ))}
      </fieldset>
      {errorText ? (
        <p className={s.formError} role="alert">
          {errorText}
        </p>
      ) : (
        <ActionError error={action.error} />
      )}
      <div className={s.formButtons}>
        <Button type="submit" variant="primary" disabled={action.busy || !f.display_name.trim()}>
          {action.busy ? busyLabel : submitLabel}
        </Button>
        {cancelHref ? (
          <Link href={cancelHref} className="small">
            {t('common.cancel')}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
