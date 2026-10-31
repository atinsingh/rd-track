'use client';

import { useState, type FormEvent } from 'react';
import type { HolidayDTO, TeamSummary } from '@rd/contracts';
import s from '@/components/scheduling/scheduling.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { InlineSelect, SelectField, TextField } from '@/components/ui/Field';
import { Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t } from '@/lib/i18n';
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
      <TextField label={t('adm.common.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <TextField label={t('adm.common.name')} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
      <SelectField label={t('adm.hol.appliesTo')} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
        <option value="">{t('adm.common.everyone')}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {t('adm.common.teamNamed', { name: team.name })}
          </option>
        ))}
      </SelectField>
      <Button type="submit" variant="primary" disabled={!name.trim() || action.busy}>
        {t('adm.hol.add')}
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

  if (!access.isAdmin) return <NoAccess what={t('adm.hol.noAccessAdmin')} />;
  if (!enabled) return <NoAccess what={t('adm.hol.noAccessPlan')} />;
  const years = [Number(thisYear) - 1, Number(thisYear), Number(thisYear) + 1].map(String);
  const sortedTeams = [...(teams.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        eyebrow={t('adm.hol.eyebrow')}
        title={t('adm.hol.title')}
        description={t('adm.hol.description')}
        actions={
          <InlineSelect label={t('adm.common.year')} value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </InlineSelect>
        }
      />
      <Card title={t('adm.hol.addTitle')}>
        <HolidayForm key={year} year={year} teams={sortedTeams} onCreated={(h) => (h.date.startsWith(year) ? holidays.reload() : setYear(h.date.slice(0, 4)))} />
      </Card>
      <Card title={t('adm.hol.inYear', { year })}>
        <ActionError error={remove.error} />
        <Resource {...holidays} label={t('adm.hol.loading')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('adm.hol.noneInYear', { year })} />
            ) : (
              <TableBox label={t('adm.hol.inYear', { year })}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.common.date')}</th>
                      <th scope="col">{t('adm.common.name')}</th>
                      <th scope="col">{t('adm.hol.appliesTo')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((h) => (
                      <tr key={h.id}>
                        <td>{formatDayLabel(h.date)}</td>
                        <td>{h.name}</td>
                        <td>{h.team_name ? t('adm.common.teamNamed', { name: h.team_name }) : t('adm.common.everyone')}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={remove.busy}
                            aria-label={t('adm.common.removeNamed', { name: h.name })}
                            onClick={async () => {
                              if (await remove.run(() => sched.admin.removeHoliday(h.id))) holidays.mutate((prev) => prev?.filter((x) => x.id !== h.id));
                            }}
                          >
                            {t('adm.common.remove')}
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
