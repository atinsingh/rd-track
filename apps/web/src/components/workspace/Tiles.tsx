import Link from 'next/link';
import type { ReactNode } from 'react';
import s from './workspace.module.css';

export interface Tile {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Where to act on it. */
  href?: string;
  /** Needs attention; marked with words as well as the edge colour. */
  alert?: boolean;
}

/** A row of headline numbers on a role home. Counts only; each links to where it's dealt with. */
export function Tiles({ label, tiles }: { label: string; tiles: readonly Tile[] }) {
  return (
    <section aria-label={label} className={s.tiles}>
      {tiles.map((t) => {
        const body = (
          <>
            <span className={s.tileLabel}>{t.label}</span>
            <span className={s.tileValue}>{t.value}</span>
            {t.sub ? <span className={s.tileSub}>{t.sub}</span> : null}
          </>
        );
        return t.href ? (
          <Link key={t.label} href={t.href} className={t.alert ? s.tileAlert : s.tile}>
            {body}
          </Link>
        ) : (
          <div key={t.label} className={t.alert ? s.tileAlert : s.tile}>
            {body}
          </div>
        );
      })}
    </section>
  );
}
