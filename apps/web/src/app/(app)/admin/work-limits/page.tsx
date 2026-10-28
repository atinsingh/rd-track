'use client';

import { useState } from 'react';
import type { WorkLimitsResponse } from '@rd/contracts';
import ts from '@/components/timesheet/timesheet.module.css';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, formActionsClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatDayMonth } from '@/lib/time';
import { formatLimitMinutes, limitInputValue, parseLimitInput, timesheetsApi } from '@/lib/timesheets';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

const HINT = 'Hours, e.g. 8, 7.5 or 7h 30m. Leave empty for no limit.';

function readLimit(raw: string, setError: (e: string | null) => void): number | null | undefined {
  const v = parseLimitInput(raw);
  if (v === 'invalid') {
    setError('Enter hours like 8, 7.5 or 7h 30m');
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
      title="Organization default"
      subtitle={
        data.organization?.effective_from ? `In force since ${formatDayMonth(data.organization.effective_from)}` : 'No limits set yet'
      }
    >
      <div className={ts.limits}>
        <TextField label="Daily limit" hint={HINT} value={daily} error={dailyErr} onChange={(e) => setDaily(e.target.value)} />
        <TextField label="Weekly limit" value={weekly} error={weeklyErr} onChange={(e) => setWeekly(e.target.value)} />
        <TextField label="Applies from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </div>
      <ActionError error={action.error} />
      {saved ? (
        <p role="status" className="small secondary">
          Saved. Weeks ending on or after {formatDayMonth(from)} use the new limits; approved weeks keep the figures they were approved with.
        </p>
      ) : null}
      <div className={formActionsClass}>
        <Button variant="primary" onClick={save} disabled={action.busy || !from}>
          Save default
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
      setDailyErr('Set a daily or weekly limit (or both)');
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
    <Card title="Per-person overrides" subtitle="An empty field uses the organization default">
      {data.users.length === 0 ? (
        <Empty title="No overrides">Everyone uses the organization default.</Empty>
      ) : (
        <TableBox label="Per-person overrides">
          <table className={tableClass} style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Daily</th>
                <th scope="col">Weekly</th>
                <th scope="col">Since</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...data.users].sort(byName).map((u) => (
                <tr key={u.user_id}>
                  <td style={{ fontWeight: 600 }}>{u.display_name}</td>
                  <td className="mono">
                    {u.daily_minutes === null ? `${formatLimitMinutes(u.effective.daily_minutes)} (default)` : formatLimitMinutes(u.daily_minutes)}
                  </td>
                  <td className="mono">
                    {u.weekly_minutes === null ? `${formatLimitMinutes(u.effective.weekly_minutes)} (default)` : formatLimitMinutes(u.weekly_minutes)}
                  </td>
                  <td className="mono small">{formatDayMonth(u.effective_from)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="sm" variant="quiet" onClick={() => save(u.user_id, null)} disabled={action.busy}>
                      Use default
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
      <h3>Add or change an override</h3>
      <div className={ts.limits}>
        <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a person</option>
          {active.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </SelectField>
        <TextField label="Daily limit" hint="Empty = organization default" value={daily} error={dailyErr} onChange={(e) => setDaily(e.target.value)} />
        <TextField label="Weekly limit" value={weekly} error={weeklyErr} onChange={(e) => setWeekly(e.target.value)} />
      </div>
      <ActionError error={action.error} />
      <div className={formActionsClass}>
        <Button variant="primary" onClick={add} disabled={action.busy || !userId}>
          Save override
        </Button>
      </div>
    </Card>
  );
}

export default function WorkLimitsPage() {
  const { access, timezone: tz } = useMe();
  const entitled = access.entitlements.includes('timesheets');
  const limits = useApi(access.isAdmin && entitled ? 'admin:work-limits' : null, (signal) => timesheetsApi.workLimits(signal));
  if (!access.isAdmin) return <NoAccess what="Work limits are set by org admins." />;
  if (!entitled) return <NoAccess what="Work limits and overtime are part of the Standard and Pro plans. Change the plan in Billing." />;
  const saved = (r: WorkLimitsResponse) => limits.mutate(() => r);

  return (
    <>
      <PageHeader
        eyebrow="Admin · Timesheets"
        title="Work limits"
        description="Daily and weekly limits used for overtime on timesheets. Employees see their own limits and overtime first; their managers see the same figures."
      />
      <Banner tag="NOTE">
        Overtime is time over a limit, counted once: daily overtime first, then any remaining time over the weekly limit. It
        is for planning and pay, never a measure of performance.
      </Banner>
      <Resource {...limits} label="Loading work limits">
        {(data) => (
          <>
            <OrgDefault key={`${data.organization?.effective_from ?? 'none'}|${tz}`} data={data} onSaved={saved} />
            <Overrides data={data} onSaved={saved} />
            {data.scheduled.length > 0 ? (
              <Card title="Scheduled changes">
                <ul>
                  {data.scheduled.map((x) => (
                    <li key={`${x.user_id ?? 'org'}|${x.effective_from}`}>
                      From {formatDayMonth(x.effective_from)}: {x.user_id ? 'override' : 'organization default'} ·{' '}
                      {formatLimitMinutes(x.daily_minutes)} a day · {formatLimitMinutes(x.weekly_minutes)} a week
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
