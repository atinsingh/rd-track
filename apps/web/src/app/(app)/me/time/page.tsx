'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { CorrectionDTO, CorrectionValues, SessionDTO } from '@rd/contracts';
import { CorrectionSheet } from '@/components/CorrectionSheet';
import { MyPayRate } from '@/components/MyPayRate';
import { DateSwitcher } from '@/components/day/DateSwitcher';
import { TimeTabs } from '@/components/timesheet/TimeTabs';
import { sessionTitle } from '@/components/day/SessionsList';
import { Button } from '@/components/ui/Button';
import { Empty, Resource } from '@/components/ui/DataState';
import { Badge, Banner, Card, PageHeader, TableBox, numClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { useMe } from '@/lib/me';
import {
  addDays,
  dateInTz,
  daysRange,
  formatDateTime,
  formatDayMonth,
  formatShortDay,
  formatTime,
  startOfWeek,
  todayInTz,
} from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';

function sourceLabel(x: SessionDTO): string {
  if (x.source === 'manual') return t('time.source.manual');
  return x.corrected ? t('time.source.corrected') : t('time.source.agent');
}

function valuesText(v: CorrectionValues | null, tz: string): string {
  if (!v) return '—';
  const s = Date.parse(v.started_at);
  const e = Date.parse(v.ended_at);
  return `${formatShortDay(dateInTz(s, tz))} ${formatTime(s, tz)}–${formatTime(e, tz)} (${formatDuration((e - s) / 1000)})`;
}

const STATUS_TONE = { pending: 'outline', approved: 'solid', rejected: 'outline' } as const;

export default function MyTimePage() {
  const { timezone } = useMe();
  const [tz, setTz] = useState(timezone);
  const params = useSearchParams();
  // ?week=YYYY-MM-DD opens that week (links from to-dos and reminders).
  const [day, setDay] = useState(() => {
    const today = todayInTz(timezone);
    const q = params.get('week');
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) && q <= today ? q : today;
  });
  const [sheet, setSheet] = useState<{ session: SessionDTO | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const week = startOfWeek(day);
  const range = daysRange(week, 7, tz);
  const sessions = useApi(`me:sessions|${range.from}|${range.to}`, (signal) =>
    rd.person.sessions('/v1/me', { from: range.from, to: range.to }, signal),
  );
  const corrections = useApi('me:corrections', (signal) => rd.my.corrections(signal));
  const pendingFor = new Set((corrections.data ?? []).filter((c) => c.status === 'pending').map((c) => c.session_id));

  const submitted = (c: CorrectionDTO) => {
    setSheet(null);
    setNotice(c.kind === 'manual_add' ? t('day.manualSubmitted') : t('time.correctionSubmitted'));
    corrections.mutate((prev) => [c, ...(prev ?? [])]);
  };

  return (
    <>
      <PageHeader
        eyebrow={t('time.eyebrow')}
        title={t('time.title')}
        description={t('time.description')}
        actions={
          <>
            <DateSwitcher
              date={day}
              onDate={setDay}
              tz={tz}
              onTz={setTz}
              step={7}
              unit="week"
              label={`${formatDayMonth(week)} – ${formatDayMonth(addDays(week, 6))}`}
            />
            <Button variant="primary" onClick={() => setSheet({ session: null })}>
              {t('time.addManual')}
            </Button>
          </>
        }
      />
      <TimeTabs current="sessions" />
      {notice ? (
        <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>{t('common.dismiss')}</Button>}>
          {t('time.reviewNote')}
        </Banner>
      ) : null}

      <Card title={t('time.sessionsWeek')}>
        <Resource {...sessions} label={t('time.loadingSessions')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('time.noSessions')}>{t('time.noSessionsBody')}</Empty>
            ) : (
              <TableBox label={t('time.sessionsWeek')}>
                <table className={tableClass} style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('time.col.day')}</th>
                      <th scope="col">{t('time.col.project')}</th>
                      <th scope="col">{t('time.col.start')}</th>
                      <th scope="col">{t('time.col.end')}</th>
                      <th scope="col" className={numClass}>
                        {t('time.col.tracked')}
                      </th>
                      <th scope="col">{t('time.col.source')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('time.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list]
                      .sort((a, b) => a.started_at.localeCompare(b.started_at))
                      .map((x) => (
                        <tr key={x.id}>
                          <td>{formatShortDay(dateInTz(Date.parse(x.started_at), tz))}</td>
                          <td style={{ fontWeight: 600 }}>{sessionTitle(x)}</td>
                          <td className="mono">{formatTime(x.started_at, tz)}</td>
                          <td className="mono">{x.ended_at ? formatTime(x.ended_at, tz) : t('session.now')}</td>
                          <td className={numClass}>{formatDuration(x.tracked_seconds)}</td>
                          <td>
                            <Badge>{sourceLabel(x)}</Badge>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {pendingFor.has(x.id) ? (
                              <span className="small muted">{t('time.correctionPending')}</span>
                            ) : (
                              <Button
                                size="sm"
                                variant="quiet"
                                disabled={x.state !== 'stopped'}
                                title={x.state !== 'stopped' ? t('time.stopFirst') : undefined}
                                onClick={() => setSheet({ session: x })}
                              >
                                {t('time.propose')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>

      <Card title={t('time.myCorrections')} subtitle={t('time.myCorrectionsSub')}>
        <Resource {...corrections} label={t('time.loadingCorrections')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('time.noCorrections')} />
            ) : (
              <TableBox label={t('time.myCorrections')}>
                <table className={tableClass} style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('time.col.submitted')}</th>
                      <th scope="col">{t('time.col.kind')}</th>
                      <th scope="col">{t('time.col.original')}</th>
                      <th scope="col">{t('time.col.requested')}</th>
                      <th scope="col">{t('time.col.reason')}</th>
                      <th scope="col">{t('time.col.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list]
                      .sort((a, b) => b.created_at.localeCompare(a.created_at))
                      .map((c) => (
                        <tr key={c.id}>
                          <td className="mono small">{formatDateTime(c.created_at, tz)}</td>
                          <td>{c.kind === 'manual_add' ? t('time.kind.manual') : c.kind === 'idle_reassign' ? t('time.kind.idle') : t('time.kind.edit')}</td>
                          <td className="mono small">{valuesText(c.original, tz)}</td>
                          <td className="mono small">{valuesText(c.requested, tz)}</td>
                          <td className="small secondary">{c.reason}</td>
                          <td>
                            <Badge tone={STATUS_TONE[c.status]}>{t(`time.status.${c.status}`)}</Badge>
                            {c.review_note ? <div className="small secondary">“{c.review_note}”</div> : null}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>

      <MyPayRate />

      <CorrectionSheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        session={sheet?.session ?? null}
        tz={tz}
        defaultDate={day}
        onSubmitted={submitted}
      />
    </>
  );
}
