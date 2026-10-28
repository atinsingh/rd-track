'use client';

import { useId } from 'react';
import s from './ui.module.css';

/**
 * ⓘ next to every computer-activity percentage: how it is calculated and what
 * it cannot see (UX §1.2, system design §6.3).
 */
export function ActivityInfo({ subject = 'computer activity' }: { subject?: string }) {
  const id = useId().replace(/:/g, '');
  const pid = `activity-info-${id}`;
  return (
    <>
      <button
        type="button"
        className={s.infoBtn}
        popoverTarget={pid}
        aria-label={`How ${subject} is calculated`}
        title={`How ${subject} is calculated`}
      >
        i
      </button>
      <div id={pid} popover="auto" role="dialog" aria-labelledby={`${pid}-h`} className={s.popover}>
        <h2 id={`${pid}-h`}>How computer activity is calculated</h2>
        <p>
          The share of measurable session time in which the keyboard or mouse was used. Only counts are recorded —
          never which keys or where you clicked.
        </p>
        <p className={s.formula}>active seconds ÷ (active + idle seconds)</p>
        <p>Not counted at all (not idle, not active):</p>
        <ul>
          <li>paused time, and time the computer was asleep or offline</li>
          <li>minutes where the agent had no permission to measure input</li>
        </ul>
        <p>It can&apos;t see meetings, calls, reading, thinking or work away from the computer, so a low number is not a judgement about anyone&apos;s work.</p>
        <button type="button" className={`${s.btn} ${s.quiet} ${s.sm} ${s.popoverClose}`} popoverTarget={pid} popoverTargetAction="hide">
          Close
        </button>
      </div>
    </>
  );
}
