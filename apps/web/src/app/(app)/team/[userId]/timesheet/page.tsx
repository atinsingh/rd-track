'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { isCalendarDate, isoWeekStart } from '@rd/contracts';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { ReviewPanel, StatusBadge, TimesheetView } from '@/components/timesheet/TimesheetView';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { Banner, Card, PageHeader } from '@/components/ui/Layout';
import { useMe } from '@/lib/me';
import { addDays, formatDayMonth, todayInTz } from '@/lib/time';
import { reviewActions, timesheetsApi } from '@/lib/timesheets';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import { NoAccess } from '../../../NoAccess';

export default function MemberTimesheetPage() {
  const { access, timezone: tz } = useMe();
  const params = useParams<{ userId: string }>();
  const search = useSearchParams();
  const userId = decodeURIComponent(params.userId ?? '');
  const initial = search.get('week');
  const today = todayInTz(tz);
  const [day, setDay] = useState(() => (initial && isCalendarDate(initial) && initial <= today ? initial : today));
  const week = isoWeekStart(day);
  const allowed = (access.managesTeams || access.isAdmin) && access.entitlements.includes('timesheets');
  const sheet = useApi(allowed && userId ? `member:timesheet|${userId}|${week}` : null, (signal) =>
    timesheetsApi.memberWeek(userId, week, signal),
  );
  const name = sheet.data?.user_name ?? search.get('name') ?? t('mgr.member.fallback');

  if (!allowed) return <NoAccess what={t('mgr.sheet.noAccess')} />;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            {access.managesTeams ? (
              <Link href="/team" style={{ color: 'inherit' }}>
                {t('nav.team')}
              </Link>
            ) : (
              <Link href="/approvals" style={{ color: 'inherit' }}>
                {t('nav.approvals')}
              </Link>
            )}
            &nbsp;· {t('mgr.col.timesheet')}
          </>
        }
        title={name}
        description={t('mgr.sheet.description', { name })}
        actions={
          <>
            {sheet.data ? <StatusBadge status={sheet.data.status} /> : null}
            <DateSwitcher
              date={day}
              onDate={setDay}
              tz={tz}
              step={7}
              unit="week"
              max={today}
              label={`${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
            />
          </>
        }
      />
      <Banner tag="NOTE">{t('mgr.sheet.note')}</Banner>
      {sheet.error ? (
        sheet.error.status === 403 ? (
          <Banner tag="NOTE">{t('mgr.sheet.cantView')}</Banner>
        ) : (
          <ErrorState error={sheet.error} onRetry={sheet.reload} />
        )
      ) : !sheet.data ? (
        <Loading label={t('mgr.sheet.loading')} />
      ) : (
        <>
          <TimesheetView sheet={sheet.data} tz={tz} self={false} />
          {reviewActions(sheet.data).length > 0 ? (
            <Card
              title={sheet.data.status === 'approved' ? t('mgr.sheet.reopenTitle') : t('mgr.sheet.reviewTitle')}
              subtitle={sheet.data.status === 'approved' ? t('mgr.sheet.reopenBody') : t('mgr.sheet.reviewBody')}
            >
              <ReviewPanel sheet={sheet.data} onDone={(t) => sheet.mutate(() => t)} />
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
