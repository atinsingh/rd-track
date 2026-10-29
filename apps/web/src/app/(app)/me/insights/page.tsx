'use client';

import { useState } from 'react';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { AgainstExpected, Days, Summary, Wellbeing, WorkApps } from '@/components/insights/Sections';
import { ButtonLink } from '@/components/ui/Button';
import { Resource } from '@/components/ui/DataState';
import { Segmented } from '@/components/ui/Field';
import { Banner, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { addDays, daysRange, formatDayMonth, startOfWeek, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';

type Period = 'week' | 'four_weeks';

export default function MyInsightsPage() {
  const { timezone } = useMe();
  const [tz, setTz] = useState(timezone);
  const [day, setDay] = useState(() => todayInTz(timezone));
  const [period, setPeriod] = useState<Period>('week');
  const days = period === 'week' ? 7 : 28;
  const start = period === 'week' ? startOfWeek(day) : addDays(startOfWeek(day), -21);
  const range = daysRange(start, days, tz);
  const insights = useApi(`me:insights|${range.from}|${range.to}|${tz}`, (signal) => rd.my.insights(range, tz, signal));

  return (
    <>
      <PageHeader
        eyebrow={t('ins.eyebrow')}
        title={t('ins.title')}
        description={t('ins.description')}
        actions={
          <>
            <Segmented<Period>
              legend={t('ins.period')}
              name="period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'week', label: t('ins.week') },
                { value: 'four_weeks', label: t('ins.fourWeeks') },
              ]}
            />
            <DateSwitcher
              date={day}
              onDate={setDay}
              tz={tz}
              onTz={setTz}
              step={7}
              unit="week"
              max={todayInTz(tz)}
              label={`${formatDayMonth(start)} – ${formatDayMonth(addDays(start, days - 1))}`}
            />
            <ButtonLink href={`/print/insights?${new URLSearchParams({ start, days: String(days), tz })}`} target="_blank" rel="noopener">
              {t('ins.savePdf')}
            </ButtonLink>
          </>
        }
      />
      <Banner tag="NOTE">
        {t('ins.note')}
      </Banner>
      <Resource {...insights} label={t('ins.loading')}>
        {(d) => (
          <>
            <Wellbeing d={d} />
            <Summary d={d} />
            <AgainstExpected d={d} byWeek={period !== 'week'} />
            <WorkApps d={d} />
            <Days d={d} />
          </>
        )}
      </Resource>
    </>
  );
}
