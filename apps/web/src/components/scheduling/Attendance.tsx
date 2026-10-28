import { attendanceNeedsMarker, type AttendanceDay, type TeamCalendarDay } from '@rd/contracts';
import { Badge } from '@/components/ui/Layout';
import { cx } from '@/lib/cx';
import { attendanceDetail, attendanceLabel, calendarCellLabel, shiftTimesLabel } from '@/lib/scheduling';
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
        {day.late && day.left_early ? ', left early' : ''}
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
    <div className={s.legend} aria-label="Legend">
      <span>
        <span className={s.swatch} aria-hidden="true" /> On schedule
      </span>
      <span>
        <span className={cx(s.swatch, s.swatchWarn)} aria-hidden="true" /> Started late, left early or nothing recorded
      </span>
      <span>
        <span className={cx(s.swatch, s.swatchLeave)} aria-hidden="true" /> On leave
      </span>
      <span>
        <span className={cx(s.swatch, s.swatchMuted)} aria-hidden="true" /> Holiday, not scheduled or still to come
      </span>
    </div>
  );
}
