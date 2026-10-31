'use client';

import { useState } from 'react';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { screenshotPolicySummary } from '@/components/day/DayView';
import { ScreenshotStrip } from '@/components/day/ScreenshotStrip';
import { Resource } from '@/components/ui/DataState';
import { Banner, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';

export default function MyScreenshotsPage() {
  const { timezone } = useMe();
  const [tz, setTz] = useState(timezone);
  const [day, setDay] = useState(() => todayInTz(timezone));
  const week = startOfWeek(day);
  const range = daysRange(week, 7, tz);
  const shots = useApi(`me:shots|${range.from}|${range.to}`, (signal) =>
    rd.person.screenshots('/v1/me', { from: range.from, to: range.to }, signal),
  );
  const policy = useApi('me:policy', (signal) => rd.my.policy(signal));
  const info = screenshotPolicySummary(policy.data);

  return (
    <>
      <PageHeader
        eyebrow={t('myshots.eyebrow')}
        title={t('myshots.title')}
        description={t('myshots.description')}
        actions={
          <DateSwitcher
            date={day}
            onDate={setDay}
            tz={tz}
            onTz={setTz}
            step={7}
            unit="week"
            label={`${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
          />
        }
      />
      {policy.data && !info.enabled ? (
        <Banner tag="NOTE" title={t('myshots.offTitle')}>
          {t('myshots.offBody')}
        </Banner>
      ) : null}
      <Resource {...shots} label={t('myshots.loading')}>
        {(list) => (
          <ScreenshotStrip
            shots={list}
            tz={tz}
            isSelf
            policyText={info.text}
            onDeletionRequested={(id) =>
              shots.mutate((prev) => prev?.map((x) => (x.id === id ? { ...x, deletion_request_status: 'pending' as const } : x)))
            }
          />
        )}
      </Resource>
    </>
  );
}
