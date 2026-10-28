'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { DayView, type Visibility } from '@/components/day/DayView';
import { Banner, PageHeader } from '@/components/ui/Layout';
import { Loading } from '@/components/ui/DataState';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { daysRange, formatDayLabel, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

export default function MemberDayPage() {
  const { access, timezone } = useMe();
  const params = useParams<{ userId: string }>();
  const search = useSearchParams();
  const userId = decodeURIComponent(params.userId ?? '');
  const teamId = search.get('team');
  const initialDate = search.get('date');
  const today = todayInTz(timezone);
  const [tz, setTz] = useState(timezone);
  const [date, setDate] = useState(() => (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) && initialDate <= today ? initialDate : today));

  // The team report says what policy lets this manager see for the team.
  const week = daysRange(startOfWeek(date), 7, tz);
  const report = useApi(teamId && access.managesTeams ? `team|${teamId}|${week.from}|${tz}` : null, (signal) =>
    rd.teams.report(teamId!, { from: week.from, to: week.to }, tz, signal),
  );
  const member = report.data?.members.find((m) => m.user_id === userId);
  const name = member?.display_name ?? search.get('name') ?? 'Team member';
  const visibility: Visibility | undefined = report.data?.visibility;

  if (!access.managesTeams) return <NoAccess what="Member pages are for team managers." />;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/team" style={{ color: 'inherit' }}>
              Team{report.data ? ` · ${report.data.team.name}` : ''}
            </Link>
            &nbsp;· {formatDayLabel(date)}
          </>
        }
        title={name}
        description={`The same day ${name} sees on their own page, limited to what policy shares with you.`}
        actions={<DateSwitcher date={date} onDate={setDate} tz={tz} onTz={setTz} max={todayInTz(tz)} />}
      />
      <Banner tag="NOTE">
        Your view of {name}&apos;s data is recorded and listed on their “What&apos;s collected” page. Computer activity
        can&apos;t see meetings, calls, reading or thinking.
      </Banner>
      {teamId && report.loading && !report.data ? (
        <Loading label="Checking what policy shares with you" />
      ) : (
        <DayView
          userId={userId}
          personName={name}
          date={date}
          tz={tz}
          visibility={visibility ?? { activity: true, apps: true, screenshots: false }}
        />
      )}
    </>
  );
}
