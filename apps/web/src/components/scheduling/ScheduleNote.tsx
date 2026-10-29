'use client';

import Link from 'next/link';
import { Banner } from '@/components/ui/Layout';
import { useMe } from '@/lib/me';
import { attendanceDetail, attendanceLabel, sched, shiftTimesLabel } from '@/lib/scheduling';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';

/**
 * My day: the person's own shift and attendance for the day, before anyone else sees it.
 * Renders nothing without the schedules plan feature, or on a day with no shift, leave or holiday.
 */
export function ScheduleNote({ date, tz }: { date: string; tz: string }) {
  const { me } = useMe();
  const on = me.entitlements.includes('schedules');
  const att = useApi(on ? `me:attendance|${date}|${date}` : null, (signal) => sched.my.attendance({ from: date, to: date }, signal));
  const d = att.data?.days[0];
  if (!d || (!d.shift && !d.holiday && !d.leave)) return null;
  const title = d.shift ? `Shift ${shiftTimesLabel(d.shift)} · ${attendanceLabel(d)}` : attendanceLabel(d);
  return (
    <Banner tag="SCHEDULE" title={title} actions={<Link href="/me/schedule">{t('schedule.mine')}</Link>}>
      {attendanceDetail(d, tz) || t('schedule.compare')}
    </Banner>
  );
}
