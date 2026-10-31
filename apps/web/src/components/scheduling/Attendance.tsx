import { attendanceNeedsMarker, type AttendanceDay, type TeamCalendarDay } from '@rd/contracts';
import { Badge } from '@/components/ui/Layout';
import { cx } from '@/lib/cx';
import { attendanceDetail, attendanceLabel, calendarCellLabel, shiftTimesLabel } from '@/lib/scheduling';
import { t } from '@/lib/i18n';
import s from './scheduling.module.css';

/** Schedule exceptions get the amber marker; everything else stays neutral ink. */
function flagged(d: AttendanceDay): boolean {
  return attendanceNeedsMarker(d.status) || d.left_early;
}

export function AttendanceBadge({ day }: { day: AttendanceDay }) {
  return <Badge tone={flagged(day) ? 'warn' : 'outline'}>{attendanceLabel(day)}</Badge>;
}

/** One person-day in a week grid. */
export function AttendanceCell({ day, tz }: { day: AttendanceDay; tz: string }) {
  const warn = flagged(day);
  const muted = day.status === 'unscheduled' || day.status === 'holiday' || day.status === 'upcoming';
  const detail = attendanceDetail(day, tz);
  const sub = day.shift ? shiftTimesLabel(day.shift) : (day.holiday ?? '');
  return (
    <div className={cx(s.cell, muted && s.cellMuted, day.status === 'on_leave' && s.cellLeave, warn && s.cellWarn)} title={detail || undefined}>
      <span className={s.cellTitle}>
        {warn ? <span className={s.marker} aria-hidden="true" /> : null}
        {attendanceLabel(day)}
        {day.late && day.left_early ? t('sched.alsoLeftEarly') : ''}
      </span>
      {sub ? <span className={s.cellSub}>{sub}</span> : null}
      {detail ? <span className="visually-hidden">{detail}</span> : null}
    </div>
  );
}

/** One person-day in the "who's off" calendar. */
export function CalendarCell({ day }: { day: TeamCalendarDay }) {
  const label = calendarCellLabel(day);
  return (
    <div className={cx(s.cell, (day.holiday || (!day.off && !day.shift)) && s.cellMuted, day.off && !day.holiday && s.cellLeave)}>
      <span className={s.cellTitle}>{label}</span>
      {day.shift && (day.off || day.holiday) ? <span className={s.cellSub}>{shiftTimesLabel(day.shift)}</span> : null}
    </div>
  );
}

export function AttendanceLegend() {
  return (
    <div className={s.legend} aria-label={t('sched.legend')}>
      <span>
        <span className={s.swatch} aria-hidden="true" /> {t('sched.att.on_time')}
      </span>
      <span>
        <span className={cx(s.swatch, s.swatchWarn)} aria-hidden="true" /> {t('sched.legendWarn')}
      </span>
      <span>
        <span className={cx(s.swatch, s.swatchLeave)} aria-hidden="true" /> {t('sched.att.on_leave')}
      </span>
      <span>
        <span className={cx(s.swatch, s.swatchMuted)} aria-hidden="true" /> {t('sched.legendMuted')}
      </span>
    </div>
  );
}
