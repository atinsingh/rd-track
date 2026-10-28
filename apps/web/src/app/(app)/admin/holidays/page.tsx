'use client';

import { useState, type FormEvent } from 'react';
import type { HolidayDTO, TeamSummary } from '@rd/contracts';
import s from '@/components/scheduling/scheduling.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { InlineSelect, SelectField, TextField } from '@/components/ui/Field';
import { Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { sched } from '@/lib/scheduling';
import { formatDayLabel, todayInTz } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

function HolidayForm({ year, teams, onCreated }: { year: string; teams: TeamSummary[]; onCreated: (h: HolidayDTO) => void }) {
  const [date, setDate] = useState(`${year}-01-01`);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => sched.admin.createHoliday({ date, name: name.trim(), team_id: teamId || null }));
    if (r) {
      setName('');
      onCreated(r);
    }
  };
  return (
    <form onSubmit={submit} className={s.inlineForm}>
      <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <TextField label="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
      <SelectField label="Applies to" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
        <option value="">Everyone</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            Team {t.name}
          </option>
        ))}
      </SelectField>
      <Button type="submit" variant="primary" disabled={!name.trim() || action.busy}>
        Add holiday
      </Button>
      <ActionError error={action.error} />
    </form>
  );
}

export default function HolidaysPage() {
  const { access, me, timezone } = useMe();
  const enabled = access.isAdmin && (me.entitlements.includes('schedules') || me.entitlements.includes('time_off'));
  const thisYear = todayInTz(timezone).slice(0, 4);
  const [year, setYear] = useState(thisYear);
  const holidays = useApi(enabled ? `admin:holidays|${year}` : null, (signal) => sched.admin.holidays(year, signal));
  const teams = useApi(enabled ? 'admin:teams' : null, (signal) => rd.admin.teams(signal));
  const remove = useAction();

  if (!access.isAdmin) return <NoAccess what="Holidays are managed by org admins." />;
  if (!enabled) return <NoAccess what="Holidays come with schedules (Pro) or time off (Standard and Pro)." />;
  const years = [Number(thisYear) - 1, Number(thisYear), Number(thisYear) + 1].map(String);
  const sortedTeams = [...(teams.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        eyebrow="Admin · Holidays"
        title="Holidays"
        description="Days off for everyone or for one team. Nobody is expected on a holiday, and full-day time off doesn't use any balance on it."
        actions={
          <InlineSelect label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </InlineSelect>
        }
      />
      <Card title="Add a holiday">
        <HolidayForm key={year} year={year} teams={sortedTeams} onCreated={(h) => (h.date.startsWith(year) ? holidays.reload() : setYear(h.date.slice(0, 4)))} />
      </Card>
      <Card title={`Holidays in ${year}`}>
        <ActionError error={remove.error} />
        <Resource {...holidays} label="Loading holidays">
          {(list) =>
            list.length === 0 ? (
              <Empty title={`No holidays in ${year} yet`} />
            ) : (
              <TableBox label={`Holidays in ${year}`}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Name</th>
                      <th scope="col">Applies to</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((h) => (
                      <tr key={h.id}>
                        <td>{formatDayLabel(h.date)}</td>
                        <td>{h.name}</td>
                        <td>{h.team_name ? `Team ${h.team_name}` : 'Everyone'}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={remove.busy}
                            aria-label={`Remove ${h.name}`}
                            onClick={async () => {
                              if (await remove.run(() => sched.admin.removeHoliday(h.id))) holidays.mutate((prev) => prev?.filter((x) => x.id !== h.id));
                            }}
                          >
                            Remove
                          </Button>
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
    </>
  );
}
