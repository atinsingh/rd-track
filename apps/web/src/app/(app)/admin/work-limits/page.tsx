'use client';

import { useState } from 'react';
import type { TimesheetRule, WorkLimitsResponse } from '@rd/contracts';
import ts from '@/components/timesheet/timesheet.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, formActionsClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName } from '@/lib/format';
import { t } from '@/lib/i18n';
import { currentLocale } from '@/lib/locale';
import { useMe } from '@/lib/me';
import { formatDayMonth } from '@/lib/time';
import { formatLimitMinutes, limitInputValue, parseLimitInput, timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

function readLimit(raw: string, setError: (e: string | null) => void): number | null | undefined {
  const v = parseLimitInput(raw);
  if (v === 'invalid') {
    setError(t('adm.wl.invalid'));
    return undefined;
  }
  setError(null);
  return v;
}

function OrgDefault({ data, onSaved }: { data: WorkLimitsResponse; onSaved: (r: WorkLimitsResponse) => void }) {
  const [daily, setDaily] = useState(limitInputValue(data.organization?.daily_minutes ?? null));
  const [weekly, setWeekly] = useState(limitInputValue(data.organization?.weekly_minutes ?? null));
  const [from, setFrom] = useState(data.as_of);
  const [dailyErr, setDailyErr] = useState<string | null>(null);
  const [weeklyErr, setWeeklyErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const save = async () => {
    setSaved(false);
    const d = readLimit(daily, setDailyErr);
    const w = readLimit(weekly, setWeeklyErr);
    if (d === undefined || w === undefined) return;
    const r = await action.run(() =>
      timesheetsApi.updateWorkLimits({ effective_from: from, organization: { daily_minutes: d, weekly_minutes: w } }),
    );
    if (r) {
      setSaved(true);
      onSaved(r);
    }
  };
  return (
    <Card
      title={t('adm.wl.orgDefault')}
      subtitle={
        data.organization?.effective_from ? t('adm.wl.inForce', { date: formatDayMonth(data.organization.effective_from) }) : t('adm.wl.noLimits')
      }
    >
      <div className={ts.limits}>
        <TextField label={t('adm.wl.daily')} hint={t('adm.wl.hint')} value={daily} error={dailyErr} onChange={(e) => setDaily(e.target.value)} />
        <TextField label={t('adm.wl.weekly')} value={weekly} error={weeklyErr} onChange={(e) => setWeekly(e.target.value)} />
        <TextField label={t('adm.wl.appliesFrom')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </div>
      <ActionError error={action.error} />
      {saved ? (
        <p role="status" className="small secondary">
          {t('adm.wl.savedDefault', { date: formatDayMonth(from) })}
        </p>
      ) : null}
      <div className={formActionsClass}>
        <Button variant="primary" onClick={save} disabled={action.busy || !from}>
          {t('adm.wl.saveDefault')}
        </Button>
      </div>
    </Card>
  );
}

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];
/** "Monday" … "Sunday" (1 January 2024 was a Monday); `capital` for French list items. */
function weekdayName(isoDay: number, capital = false): string {
  const name = new Intl.DateTimeFormat(currentLocale(), { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, isoDay));
  return capital ? name[0]!.toUpperCase() + name.slice(1) : name;
}

/** Engine rule (G19): when a week's timesheet is due, with a reminder, an overdue notice and an escalation. */
function DeadlineRule({ rule, onSaved }: { rule: TimesheetRule; onSaved: (r: TimesheetRule) => void }) {
  const [draft, setDraft] = useState(rule);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = (patch: Partial<TimesheetRule>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const save = async () => {
    const r = await action.run(() => rd.admin.setTimesheetRule(draft));
    if (r) {
      setSaved(true);
      onSaved(r);
    }
  };
  const day = weekdayName(draft.due_weekday);
  return (
    <Card
      title={t('adm.wl.deadline')}
      subtitle={rule.enabled ? t('adm.wl.dueSub', { day: weekdayName(rule.due_weekday), time: rule.due_time }) : t('adm.wl.off')}
    >
      <Checkbox
        label={t('adm.wl.remind')}
        hint={t('adm.wl.remindHint')}
        checked={draft.enabled}
        onChange={(e) => set({ enabled: e.target.checked })}
      />
      <div className={ts.limits}>
        <SelectField
          label={t('adm.wl.dueOn')}
          value={draft.due_weekday}
          disabled={!draft.enabled}
          onChange={(e) => set({ due_weekday: Number(e.target.value) })}
        >
          {ISO_DAYS.map((d) => (
            <option key={d} value={d}>
              {weekdayName(d, true)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('adm.wl.at')} type="time" value={draft.due_time} disabled={!draft.enabled} onChange={(e) => set({ due_time: e.target.value })} required />
        <SelectField
          label={t('adm.wl.tellReviewers')}
          value={draft.escalate_after_hours}
          disabled={!draft.enabled}
          onChange={(e) => set({ escalate_after_hours: Number(e.target.value) })}
        >
          <option value={0}>{t('adm.wl.never')}</option>
          <option value={4}>{t('adm.wl.after4h')}</option>
          <option value={24}>{t('adm.wl.after1d')}</option>
          <option value={48}>{t('adm.wl.after2d')}</option>
          <option value={72}>{t('adm.wl.after3d')}</option>
        </SelectField>
      </div>
      {draft.enabled ? (
        <p className="small secondary">
          {t('adm.wl.explain', {
            day,
            time: draft.due_time,
            escalate: draft.escalate_after_hours ? t('adm.wl.escalate', { n: draft.escalate_after_hours }) : '',
          })}
        </p>
      ) : null}
      <ActionError error={action.error} />
      {saved ? (
        <p role="status" className="small secondary">
          {t('adm.wl.saved')}
        </p>
      ) : null}
      <div className={formActionsClass}>
        <Button variant="primary" onClick={save} disabled={action.busy || !/^\d{2}:\d{2}$/.test(draft.due_time)}>
          {t('adm.wl.saveDeadline')}
        </Button>
      </div>
    </Card>
  );
}

function Overrides({ data, onSaved }: { data: WorkLimitsResponse; onSaved: (r: WorkLimitsResponse) => void }) {
  const users = useApi('admin:users', (signal) => rd.admin.users(signal));
  const [userId, setUserId] = useState('');
  const [daily, setDaily] = useState('');
  const [weekly, setWeekly] = useState('');
  const [dailyErr, setDailyErr] = useState<string | null>(null);
  const [weeklyErr, setWeeklyErr] = useState<string | null>(null);
  const action = useAction();
  const save = async (id: string, limits: { daily_minutes: number | null; weekly_minutes: number | null } | null) => {
    const r = await action.run(() => timesheetsApi.updateWorkLimits({ effective_from: data.as_of, users: [{ user_id: id, limits }] }));
    if (r) onSaved(r);
    return r;
  };
  const add = async () => {
    const d = readLimit(daily, setDailyErr);
    const w = readLimit(weekly, setWeeklyErr);
    if (d === undefined || w === undefined || !userId) return;
    if (d === null && w === null) {
      setDailyErr(t('adm.wl.setOne'));
      return;
    }
    if (await save(userId, { daily_minutes: d, weekly_minutes: w })) {
      setUserId('');
      setDaily('');
      setWeekly('');
    }
  };
  const active = [...(users.data ?? [])].filter((u) => u.status === 'active').sort(byName);
  return (
    <Card title={t('adm.wl.overrides')} subtitle={t('adm.wl.overridesSub')}>
      {data.users.length === 0 ? (
        <Empty title={t('adm.wl.noOverrides')}>{t('adm.wl.noOverridesBody')}</Empty>
      ) : (
        <TableBox label={t('adm.wl.overrides')}>
          <table className={tableClass} style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th scope="col">{t('adm.common.person')}</th>
                <th scope="col">{t('adm.wl.colDaily')}</th>
                <th scope="col">{t('adm.wl.colWeekly')}</th>
                <th scope="col">{t('adm.wl.since')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('adm.common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...data.users].sort(byName).map((u) => (
                <tr key={u.user_id}>
                  <td style={{ fontWeight: 600 }}>{u.display_name}</td>
                  <td className="mono">
                    {u.daily_minutes === null ? t('adm.wl.withDefault', { limit: formatLimitMinutes(u.effective.daily_minutes) }) : formatLimitMinutes(u.daily_minutes)}
                  </td>
                  <td className="mono">
                    {u.weekly_minutes === null ? t('adm.wl.withDefault', { limit: formatLimitMinutes(u.effective.weekly_minutes) }) : formatLimitMinutes(u.weekly_minutes)}
                  </td>
                  <td className="mono small">{formatDayMonth(u.effective_from)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="sm" variant="quiet" onClick={() => save(u.user_id, null)} disabled={action.busy}>
                      {t('adm.wl.useDefault')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
      <h3>{t('adm.wl.addOverride')}</h3>
      <div className={ts.limits}>
        <SelectField label={t('adm.common.person')} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">{t('adm.wl.choosePerson')}</option>
          {active.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </SelectField>
        <TextField label={t('adm.wl.daily')} hint={t('adm.wl.emptyDefault')} value={daily} error={dailyErr} onChange={(e) => setDaily(e.target.value)} />
        <TextField label={t('adm.wl.weekly')} value={weekly} error={weeklyErr} onChange={(e) => setWeekly(e.target.value)} />
      </div>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button variant="primary" onClick={add} disabled={action.busy || !userId}>
          {t('adm.wl.saveOverride')}
        </Button>
      </div>
    </Card>
  );
}

export default function WorkLimitsPage() {
  const { access, timezone: tz } = useMe();
  const entitled = access.entitlements.includes('timesheets');
  const limits = useApi(access.isAdmin && entitled ? 'admin:work-limits' : null, (signal) => timesheetsApi.workLimits(signal));
  const rule = useApi(access.isAdmin && entitled ? 'admin:timesheet-rule' : null, (signal) => rd.admin.timesheetRule(signal));
  if (!access.isAdmin) return <NoAccess what={t('adm.wl.noAccessAdmin')} />;
  if (!entitled) return <NoAccess what={t('adm.wl.noAccessPlan')} />;
  const saved = (r: WorkLimitsResponse) => limits.mutate(() => r);

  return (
    <>
      <PageHeader
        eyebrow={t('adm.wl.eyebrow')}
        title={t('adm.wl.title')}
        description={t('adm.wl.description')}
      />
      <Banner tag={t('adm.common.noteTag')}>{t('adm.wl.banner')}</Banner>
      <Resource {...rule} label={t('adm.wl.loadingDeadline')}>
        {(r) => <DeadlineRule rule={r} onSaved={(next) => rule.mutate(() => next)} />}
      </Resource>
      <Resource {...limits} label={t('adm.wl.loading')}>
        {(data) => (
          <>
            <OrgDefault key={`${data.organization?.effective_from ?? 'none'}|${tz}`} data={data} onSaved={saved} />
            <Overrides data={data} onSaved={saved} />
            {data.scheduled.length > 0 ? (
              <Card title={t('adm.wl.scheduled')}>
                <ul>
                  {data.scheduled.map((x) => (
                    <li key={`${x.user_id ?? 'org'}|${x.effective_from}`}>
                      {t('adm.wl.scheduledLine', {
                        date: formatDayMonth(x.effective_from),
                        what: x.user_id ? t('adm.wl.override') : t('adm.wl.orgDefaultLower'),
                        daily: t('ts.aDay', { limit: formatLimitMinutes(x.daily_minutes) }),
                        weekly: t('ts.aWeek', { limit: formatLimitMinutes(x.weekly_minutes) }),
                      })}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </>
        )}
      </Resource>
    </>
  );
}
