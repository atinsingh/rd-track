'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  PLAN_IDS,
  SUPPORT_GRANT_MAX_HOURS,
  SUPPORT_SECTIONS,
  type AuditEventDTO,
  type DeviceDTO,
  type Page,
  type PlanId,
  type PlatformTenantDetail,
  type PolicyListResponse,
  type SupportGrantDTO,
  type SupportSection,
  type UserDTO,
} from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading, Resource } from '@/components/ui/DataState';
import { Segmented, SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, formActionsClass, formGridClass, numClass, tableClass } from '@/components/ui/Layout';
import { platform } from '@/lib/platform';
import { formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';

const TZ = 'UTC';
const STATE_LABEL: Record<SupportGrantDTO['state'], string> = { pending: 'Waiting for the organization', active: 'Open', expired: 'Expired', denied: 'Declined', ended: 'Ended' };
const SECTION_LABEL: Record<SupportSection, string> = { people: 'People', teams: 'Teams', devices: 'Computers', policies: 'Policies', audit: 'Audit log' };

function Subscription({ t, onSaved }: { t: PlatformTenantDetail; onSaved: () => void }) {
  const [plan, setPlan] = useState<PlanId>(t.plan);
  const [seats, setSeats] = useState(String(t.seats));
  const [status, setStatus] = useState(t.status);
  const [price, setPrice] = useState(t.price_per_seat_cents === null ? '' : (t.price_per_seat_cents / 100).toFixed(2));
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = price.trim() === '' ? null : Math.round(Number(price) * 100);
    if (await action.run(() => platform.updateSubscription(t.id, { plan, seats: Number(seats) || 0, status, price_per_seat_cents: cents }))) onSaved();
  };
  return (
    <Card title="Plan and seats" subtitle={`${t.billable_seats} tracking (billable) · ${t.viewer_seats} viewers · billed per ${t.billing_interval}`}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={formGridClass}>
          <SelectField label="Plan" value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>
            {PLAN_IDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </SelectField>
          <TextField label="Licensed seats" type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} />
          <SelectField label="State" value={status} onChange={(e) => setStatus(e.target.value as PlatformTenantDetail['status'])}>
            {(['trialing', 'active', 'past_due', 'grace', 'inactive', 'canceled'] as const).map((st) => (
              <option key={st} value={st}>
                {st.replace('_', ' ')}
              </option>
            ))}
          </SelectField>
          <TextField label="Custom price per seat (USD/month)" hint="Empty: list price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <p className="small muted">Every change is written to the organization&apos;s audit log as RoundDigital support.</p>
        <ActionError error={action.error} />
        <div className={formActionsClass}>
          <Button type="submit" variant="primary" disabled={action.busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Health({ t }: { t: PlatformTenantDetail }) {
  return (
    <Card title="Health" subtitle="Counts only">
      <dl className={dlClass}>
        <dt>People</dt>
        <dd>{t.people}</dd>
        <dt>Computers connected</dt>
        <dd>
          {t.devices}
          {t.devices_stale ? ` · ${t.devices_stale} not synced for 3+ working days` : ''}
        </dd>
        <dt>Last sync</dt>
        <dd>{t.last_sync_at ? formatDateTime(t.last_sync_at, TZ) : 'Never'}</dd>
        <dt>Agent versions</dt>
        <dd>{t.agent_versions.length ? t.agent_versions.map((v) => `${v.version} × ${v.count}`).join(' · ') : '—'}</dd>
        <dt>Trial ends</dt>
        <dd>{t.trial_ends_at ? formatDateTime(t.trial_ends_at, TZ) : '—'}</dd>
        <dt>Grace ends</dt>
        <dd>{t.grace_ends_at ? formatDateTime(t.grace_ends_at, TZ) : '—'}</dd>
      </dl>
    </Card>
  );
}

function SupportView({ orgId }: { orgId: string }) {
  const [section, setSection] = useState<SupportSection>('people');
  const res = useApi(`platform:support|${orgId}|${section}`, (signal) => platform.supportRead<unknown>(orgId, section, signal));
  return (
    <Card
      title="Read-only setup"
      subtitle="Each view you open is recorded in the organization's audit log."
      actions={
        <Segmented<SupportSection>
          legend="Section"
          name="support-section"
          value={section}
          onChange={setSection}
          options={SUPPORT_SECTIONS.map((x) => ({ value: x, label: SECTION_LABEL[x] }))}
        />
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading label="Loading" />
      ) : section === 'people' ? (
        <TableBox label="People">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                <th scope="col">Tracks</th>
                <th scope="col">Two-factor</th>
                <th scope="col">Teams</th>
              </tr>
            </thead>
            <tbody>
              {(res.data as { items: UserDTO[] }).items.map((u) => (
                <tr key={u.id}>
                  <th scope="row">
                    {u.display_name} <span className="small muted">{u.email}</span>
                  </th>
                  <td>{u.org_role}</td>
                  <td>{u.status !== 'active' ? 'Deactivated' : u.invite_pending ? 'Invited' : 'Active'}</td>
                  <td>{u.tracking_enabled ? 'Yes' : 'No'}</td>
                  <td>{u.mfa_enabled ? 'On' : 'Off'}</td>
                  <td className="small">{u.teams.map((x) => `${x.name}${x.role === 'manager' ? ' (manager)' : ''}`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      ) : section === 'teams' ? (
        <TableBox label="Teams">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col" className={numClass}>
                  Members
                </th>
                <th scope="col">Managers</th>
              </tr>
            </thead>
            <tbody>
              {(res.data as { items: { id: string; name: string; member_count: number; members: { display_name: string; role: string }[] }[] }).items.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td className={numClass}>{t.member_count}</td>
                  <td>{t.members.filter((m) => m.role === 'manager').map((m) => m.display_name).join(', ') || 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      ) : section === 'devices' ? (
        <TableBox label="Computers">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Computer</th>
                <th scope="col">Person</th>
                <th scope="col">System</th>
                <th scope="col">Agent</th>
                <th scope="col">Last sync</th>
                <th scope="col">Permissions</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {(res.data as { items: DeviceDTO[] }).items.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.name}</th>
                  <td>{d.user_name}</td>
                  <td className="small">
                    {d.os} {d.os_version}
                  </td>
                  <td className="mono small">{d.agent_version}</td>
                  <td className="small">{d.last_sync_at ? formatRelative(d.last_sync_at, TZ) : 'Never'}</td>
                  <td className="small">
                    {Object.entries(d.permissions)
                      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
                      .join(' · ') || '—'}
                    {d.clock_skew_detected ? ' · clock skew' : ''}
                  </td>
                  <td>{d.credential_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      ) : section === 'policies' ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(res.data as PolicyListResponse).scopes.map((p) => (
            <li key={`${p.scope_type}:${p.scope_id}`}>
              <strong>
                {p.scope_type} · {p.scope_name}
              </strong>{' '}
              <span className="small muted">
                {p.current ? `v${p.current.version}, ${formatDateTime(p.current.published_at, TZ)}: ${p.current.change_note}` : 'No policy of its own'}
              </span>
              {p.current ? <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{JSON.stringify(p.current.settings, null, 2)}</pre> : null}
            </li>
          ))}
        </ul>
      ) : (
        <TableBox label="Audit log">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {(res.data as Page<AuditEventDTO>).items.map((e) => (
                <tr key={e.id}>
                  <td className="mono small">{formatDateTime(e.created_at, TZ)}</td>
                  <td className="small">{e.actor_name ?? e.actor_type}</td>
                  <td className="mono small">{e.action}</td>
                  <td>{e.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
    </Card>
  );
}

function Support({ t, onChanged }: { t: PlatformTenantDetail; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('4');
  const action = useAction();
  const mine = t.grants.find((g) => g.state === 'active' || g.state === 'pending');
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => platform.requestSupport(t.id, reason.trim(), Number(hours)))) {
      setReason('');
      onChanged();
    }
  };
  return (
    <>
      <Card title="Support access" subtitle="Read-only, for the hours the organization approves. Their admins decide, and can end it any time.">
        {mine?.state === 'active' ? (
          <Banner tag="OPEN" title={`Access open until ${formatDateTime(mine.expires_at, TZ)} UTC`} actions={<Button size="sm" onClick={() => void action.run(() => platform.endSupport(mine.id)).then((r) => r && onChanged())}>End now</Button>}>
            Approved by {mine.decided_by_name ?? 'an admin'}. Reason: “{mine.reason}”
          </Banner>
        ) : mine?.state === 'pending' ? (
          <Banner tag="ASKED" title="Waiting for the organization to decide" actions={<Button size="sm" variant="quiet" onClick={() => void action.run(() => platform.endSupport(mine.id)).then((r) => r && onChanged())}>Withdraw</Button>}>
            Asked {formatRelative(mine.created_at, TZ)} for {mine.requested_hours} hours: “{mine.reason}”. Their org admins were notified.
          </Banner>
        ) : (
          <form onSubmit={ask} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TextArea label="Why you need access" hint="The organization's admins read this before deciding" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            <TextField label="For how many hours" type="number" min={1} max={SUPPORT_GRANT_MAX_HOURS} value={hours} onChange={(e) => setHours(e.target.value)} />
            <div className={formActionsClass}>
              <Button type="submit" variant="primary" disabled={action.busy || reason.trim().length < 10 || !(Number(hours) >= 1 && Number(hours) <= SUPPORT_GRANT_MAX_HOURS)}>
                Ask for access
              </Button>
            </div>
          </form>
        )}
        <ActionError error={action.error} />
        {t.grants.length ? (
          <TableBox label="Past requests">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">Asked</th>
                  <th scope="col">By</th>
                  <th scope="col">Hours</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {t.grants.map((g) => (
                  <tr key={g.id}>
                    <td className="small">{formatDateTime(g.created_at, TZ)}</td>
                    <td>{g.operator_name}</td>
                    <td>{g.requested_hours}</td>
                    <td>
                      <Badge tone={g.state === 'active' ? 'warn' : 'outline'}>{STATE_LABEL[g.state]}</Badge>
                    </td>
                    <td className="small secondary">{g.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        ) : null}
      </Card>
      {mine?.state === 'active' ? <SupportView orgId={t.id} /> : null}
    </>
  );
}

export default function TenantPage() {
  const { id } = useParams<{ id: string }>();
  const t = useApi(`platform:tenant|${id}`, (signal) => platform.tenant(id, signal));
  return (
    <Resource {...t} label="Loading the organization">
      {(d) => (
        <>
          <PageHeader
            eyebrow={
              <>
                <Link href="/platform">Organizations</Link> · {d.slug}
              </>
            }
            title={d.name}
            description={`${d.region} · created ${formatDateTime(d.created_at, TZ)} UTC`}
          />
          {d.status === 'past_due' || d.status === 'grace' ? <Banner tone="warn" title={`Billing needs attention: ${d.status.replace('_', ' ')}`} /> : null}
          <Subscription key={`${d.plan}|${d.seats}|${d.status}`} t={d} onSaved={t.reload} />
          <Health t={d} />
          <Support t={d} onChanged={t.reload} />
        </>
      )}
    </Resource>
  );
}
