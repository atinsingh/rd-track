import type { ReactNode } from 'react';
import s from './stats.module.css';

export interface Stat {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}

/** A row of headline numbers (dt/dd pairs). */
export function Stats({ items }: { items: Stat[] }) {
  return (
    <dl className={s.stats}>
      {items.map((i) => (
        <div key={i.label} className={s.stat}>
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
          {i.note ? <span className={s.note}>{i.note}</span> : null}
        </div>
      ))}
    </dl>
  );
}

export { s as statStyles };
