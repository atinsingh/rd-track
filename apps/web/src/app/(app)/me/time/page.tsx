'use client';

import { useState } from 'react';
import type { CorrectionDTO, CorrectionValues, SessionDTO } from '@rd/contracts';
import { CorrectionSheet } from '@/components/CorrectionSheet';
import { DateSwitcher } from '@/components/day/DateSwitcher';
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

function sourceLabel(x: SessionDTO): string {
  if (x.source === 'manual') return 'Manual';
  return x.corrected ? 'Corrected' : 'Agent';
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
  const [day, setDay] = useState(() => todayInTz(timezone));
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
    setNotice(c.kind === 'manual_add' ? 'Manual time submitted for approval' : 'Correction submitted for approval');
    corrections.mutate((prev) => [c, ...(prev ?? [])]);
  };

  return (
    <>
      <PageHeader
        eyebrow="Employee · Time records"
        title="My time"
        description="Your sessions for the week. If something is wrong, propose a correction — the original stays on record."
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
              + Add manual time
            </Button>
          </>
        }
      />
      {notice ? (
        <Banner role="status" title={notice} actions={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>Dismiss</Button>}>
          Your manager reviews it. You&apos;ll see the decision below.
        </Banner>
      ) : null}

      <Card title="Sessions this week">
        <Resource {...sessions} label="Loading sessions">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No sessions this week">Add manual time for work you did away from the computer.</Empty>
            ) : (
              <TableBox label="Sessions this week">
                <table className={tableClass} style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Project</th>
                      <th scope="col">Start</th>
                      <th scope="col">End</th>
                      <th scope="col" className={numClass}>
                        Tracked
                      </th>
                      <th scope="col">Source</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
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
                          <td className="mono">{x.ended_at ? formatTime(x.ended_at, tz) : 'now'}</td>
                          <td className={numClass}>{formatDuration(x.tracked_seconds)}</td>
                          <td>
                            <Badge>{sourceLabel(x)}</Badge>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {pendingFor.has(x.id) ? (
                              <span className="small muted">Correction pending</span>
                            ) : (
                              <Button
                                size="sm"
                                variant="quiet"
                                disabled={x.state !== 'stopped'}
                                title={x.state !== 'stopped' ? 'Stop the session before correcting it' : undefined}
                                onClick={() => setSheet({ session: x })}
                              >
                                Propose correction
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

      <Card title="My corrections" subtitle="Pending, approved and rejected, with your manager's note">
        <Resource {...corrections} label="Loading corrections">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No corrections yet" />
            ) : (
              <TableBox label="My corrections">
                <table className={tableClass} style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th scope="col">Submitted</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Original</th>
                      <th scope="col">Requested</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list]
                      .sort((a, b) => b.created_at.localeCompare(a.created_at))
                      .map((c) => (
                        <tr key={c.id}>
                          <td className="mono small">{formatDateTime(c.created_at, tz)}</td>
                          <td>{c.kind === 'manual_add' ? 'Manual time' : 'Edit'}</td>
                          <td className="mono small">{valuesText(c.original, tz)}</td>
                          <td className="mono small">{valuesText(c.requested, tz)}</td>
                          <td className="small secondary">{c.reason}</td>
                          <td>
                            <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
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
