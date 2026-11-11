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
import { t } from '@/lib/i18n';
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
  const name = member?.display_name ?? search.get('name') ?? t('mgr.member.fallback');
  // What policy shares with this manager about this one person (not the team as a whole).
  const vis = useApi(access.managesTeams && userId ? `visibility|${userId}` : null, (signal) => rd.person.visibility(userId, signal));
  const visibility: Visibility | undefined = vis.data
    ? { activity: vis.data.activity, apps: vis.data.apps, screenshots: vis.data.screenshots }
    : undefined;

  if (!access.managesTeams) return <NoAccess what={t('mgr.member.noAccess')} />;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/team" style={{ color: 'inherit' }}>
              {t('nav.team')}
              {report.data ? ` · ${report.data.team.name}` : ''}
            </Link>
            &nbsp;· {formatDayLabel(date)}
          </>
        }
        title={name}
        description={t('mgr.member.description', { name })}
        actions={<DateSwitcher date={date} onDate={setDate} tz={tz} onTz={setTz} max={todayInTz(tz)} />}
      />
      <Banner tag="NOTE">
        {t('mgr.member.note', { name })}
      </Banner>
      {vis.error ? (
        <Banner tag="NOTE">{t('mgr.member.cantView')}</Banner>
      ) : !vis.data ? (
        <Loading label={t('mgr.member.checking')} />
      ) : (
        <DayView
          userId={userId}
          personName={name}
          date={date}
          tz={tz}
          visibility={visibility ?? { activity: false, apps: false, screenshots: false }}
        />
      )}
    </>
  );
}
