'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { CorrectionSheet } from '@/components/CorrectionSheet';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { DayView } from '@/components/day/DayView';
import { TodoList } from '@/components/day/TodoList';
import { ScheduleNote } from '@/components/scheduling/ScheduleNote';
import { Button } from '@/components/ui/Button';
import { Banner, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatDayLabel, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';

export default function MyDayPage() {
  const { me, timezone } = useMe();
  const [tz, setTz] = useState(timezone);
  const params = useSearchParams();
  const [date, setDate] = useState(() => {
    const today = todayInTz(timezone);
    const q = params.get('date');
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) && q <= today ? q : today;
  });
  const [sheet, setSheet] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const policy = useApi('me:policy', (signal) => rd.my.policy(signal));

  return (
    <>
      <PageHeader
        eyebrow={`Employee · ${formatDayLabel(date)}`}
        title="My day"
        description="Exactly what your manager can see about you — and nothing more."
        actions={<DateSwitcher date={date} onDate={setDate} tz={tz} onTz={setTz} max={todayInTz(tz)} />}
      />
      {!me.user.tracking_enabled ? (
        <Banner tag="NOTE" title="Tracking is off for your account">
          You can&apos;t start work sessions, so nothing new is collected about you. Older records stay visible here.
        </Banner>
      ) : null}
      <ScheduleNote date={date} tz={tz} />
      <TodoList />
      {notice ? (
        <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>Dismiss</Button>}>
          Track its status in <a href="/me/time">My time</a>.
        </Banner>
      ) : null}
      <DayView
        userId={null}
        date={date}
        tz={tz}
        policy={policy.data}
        sessionAction={
          <Button size="sm" onClick={() => setSheet(true)}>
            + Add manual time
          </Button>
        }
      />
      <CorrectionSheet
        open={sheet}
        onClose={() => setSheet(false)}
        session={null}
        tz={tz}
        defaultDate={date}
        onSubmitted={() => {
          setSheet(false);
          setNotice('Manual time submitted for approval');
        }}
      />
    </>
  );
}
