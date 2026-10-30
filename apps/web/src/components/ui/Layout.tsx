import { useId, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { t, type MessageKey } from '@/lib/i18n';
import { en } from '@/lib/messages/en';
import s from './ui.module.css';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={s.pageHeader}>
      <div className={s.pageHeaderText}>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className={s.pageActions}>{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  tone = 'light',
  className,
  as: As = 'section',
  label,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: 'light' | 'ink';
  className?: string;
  as?: 'section' | 'aside' | 'div';
  /** accessible name when there is no visible title */
  label?: string;
}) {
  const id = useId();
  const labelled = title ? { 'aria-labelledby': id } : label ? { 'aria-label': label } : {};
  return (
    <As className={cx(s.card, tone === 'ink' && s.cardInk, className)} {...labelled}>
      {title || actions || subtitle ? (
        <div className={s.cardHead}>
          {title ? <h2 id={id}>{title}</h2> : <span />}
          {subtitle ? <span className={s.cardSub}>{subtitle}</span> : null}
          {actions}
        </div>
      ) : null}
      {children}
    </As>
  );
}

export function Badge({
  children,
  tone = 'outline',
  className,
}: {
  children: ReactNode;
  tone?: 'outline' | 'solid' | 'warn' | 'ink';
  className?: string;
}) {
  return (
    <span
      className={cx(
        s.badge,
        tone === 'solid' && s.badgeSolid,
        tone === 'warn' && s.badgeWarn,
        tone === 'ink' && s.badgeInk,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A banner's small tag ("NOTE", "PRIVATE"…) in the current language; unknown tags as given. */
const tagText = (tag: string) => (`tag.${tag}` in en ? t(`tag.${tag}` as MessageKey) : tag);

export function Banner({
  tone = 'note',
  title,
  children,
  actions,
  role,
  tag,
}: {
  tone?: 'note' | 'ink' | 'warn' | 'error';
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: 'status' | 'alert';
  /** small mono tag shown on note banners, e.g. "NOTE" */
  tag?: string;
}) {
  return (
    <div
      role={role}
      className={cx(
        s.banner,
        tone === 'ink' && s.bannerInk,
        tone === 'warn' && s.bannerWarn,
        tone === 'error' && s.bannerError,
      )}
    >
      {tone === 'ink' ? <span className={s.dot} aria-hidden="true" /> : null}
      {tag ? <span className={s.noteTag}>{tagText(tag)}</span> : null}
      <div className={s.bannerBody}>
        {title ? <span className={s.bannerTitle}>{title}</span> : null}
        {children ? <span>{children}</span> : null}
      </div>
      {actions ? <div className={s.bannerActions}>{actions}</div> : null}
    </div>
  );
}

/** Horizontally scrolling box for wide tables (keyboard-scrollable). */
export function TableBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.tableBox} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export const tableClass = s.table;
export const numClass = s.num;
export const dlClass = s.dl;
export const formGridClass = s.formGrid;
export const formActionsClass = s.formActions;

export function Meter({
  value,
  max,
  mark,
  label,
  scale,
}: {
  value: number;
  /** full width of the track */
  max: number;
  /** position of a tick (e.g. licensed seats) */
  mark?: number;
  label: string;
  scale?: [string, string];
}) {
  const pct = (n: number) => `${Math.max(0, Math.min(100, max > 0 ? (n / max) * 100 : 0))}%`;
  const within = mark !== undefined ? Math.min(value, mark) : value;
  return (
    <div className={s.meter}>
      <div className={s.meterTrack} role="img" aria-label={label}>
        <span className={s.meterFill} style={{ width: pct(within) }} />
        {mark !== undefined && value > mark ? (
          <span className={s.meterOver} style={{ left: pct(mark), width: `calc(${pct(value)} - ${pct(mark)})` }} />
        ) : null}
        {mark !== undefined ? <span className={s.meterTick} style={{ left: pct(mark) }} /> : null}
      </div>
      {scale ? (
        <div className={s.meterScale} aria-hidden="true">
          <span>{scale[0]}</span>
          <span>{scale[1]}</span>
        </div>
      ) : null}
    </div>
  );
}
