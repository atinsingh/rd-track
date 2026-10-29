'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { enrollmentLink, type AgentUpdateMode, type DeviceDTO, type EnrollmentCodeResponse, type PermissionState } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { MdmDeployment } from '@/components/devices/MdmDeployment';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented, SelectField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { formatCountdown, formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from '../admin.module.css';

const OS_LABEL: Record<DeviceDTO['os'], string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const PERMS: { key: string; label: string }[] = [
  { key: 'input_monitoring', label: 'Input' },
  { key: 'screen_recording', label: 'Screen' },
  { key: 'accessibility', label: 'Accessibility' },
];

function isBehind(d: DeviceDTO): boolean {
  return d.credential_status === 'active' && (d.applied_policy_revision === null || d.applied_policy_revision < d.current_policy_revision);
}
function missingPermissions(d: DeviceDTO): string[] {
  return PERMS.filter((p) => d.permissions[p.key] === 'denied').map((p) => p.label);
}

function permText(state: PermissionState | undefined): string {
  switch (state) {
    case 'granted':
      return '✓';
    case 'denied':
      return 'missing';
    case 'not_required':
      return '—';
    default:
      return '?';
  }
}
const PERM_SR: Record<string, string> = { granted: 'granted', denied: 'missing', not_required: 'not needed', unknown: 'unknown' };

function Permissions({ d }: { d: DeviceDTO }) {
  const shown = PERMS.filter((p) => d.permissions[p.key] !== undefined && !(p.key === 'accessibility' && d.permissions[p.key] === 'not_required'));
  if (shown.length === 0) return <span className={s.perm}>Not reported yet</span>;
  const missing = missingPermissions(d).length > 0;
  return (
    <span className={missing ? s.permWarn : s.perm}>
      {shown.map((p, i) => {
        const st = d.permissions[p.key];
        return (
          <span key={p.key}>
            {i > 0 ? ' · ' : ''}
            <span aria-hidden="true">
              {p.label} {permText(st)}
            </span>
            <span className="visually-hidden">
              {p.label} permission {PERM_SR[st ?? 'unknown']}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Date.parse(expiresAt) - now;
  return left > 0 ? (
    <>
      Expires in{' '}
      <strong className="mono" style={{ color: '#fff' }}>
        {formatCountdown(left)}
      </strong>
    </>
  ) : (
    <strong style={{ color: '#fff' }}>This code has expired — create a new one</strong>
  );
}

function EnrollDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const users = useApi(open ? 'admin:users' : null, (signal) => rd.admin.users(signal));
  const [userId, setUserId] = useState('');
  const [code, setCode] = useState<EnrollmentCodeResponse | null>(null);
  const action = useAction();
  const person = users.data?.find((u) => u.id === (code?.user_id ?? userId));
  const close = () => {
    setCode(null);
    setUserId('');
    action.reset();
    onClose();
  };
  const create = async () => {
    const r = await action.run(() => rd.admin.enrollmentCode(userId));
    if (r) setCode(r);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      tone="ink"
      size="sm"
      eyebrow="Enrollment code"
      title={code ? `For ${person?.display_name ?? 'this person'}` : 'New enrollment code'}
      description={code ? undefined : 'A single-use code links one device to one person. It is shown only once.'}
      footer={
        code ? (
          <>
            <CopyButton text={code.code} label="Copy code" variant="inverse" />
            <CopyButton text={enrollmentLink(window.location.origin, code.code)} label="Copy link" variant="inverse" />
            <Button variant="quiet" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!userId || action.busy} onClick={create}>
              {action.busy ? 'Creating…' : 'Create code'}
            </Button>
          </>
        )
      }
    >
      {code ? (
        <>
          <div className={s.code} aria-label="Enrollment code">
            {code.code}
          </div>
          <p role="timer" aria-live="off">
            Single use. <Countdown expiresAt={code.expires_at} />. Shown only once — share it directly with {person?.display_name ?? 'them'}.
          </p>
          <p className="small" style={{ color: 'var(--ink-muted)' }}>
            The link opens the Track app with the server address and code filled in. People who track can also get their own code under My computers.
          </p>
          <p className="small" style={{ color: 'var(--ink-muted)' }}>
            On first run the agent explains what it collects and asks for the macOS or Windows permissions it needs. It never installs or tracks silently.
          </p>
        </>
      ) : (
        <>
          <div style={{ color: 'var(--text)' }}>
            <SelectField
              label={<span style={{ color: '#fff' }}>Person</span>}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={!users.data}
              hint={<span style={{ color: 'var(--ink-muted)' }}>Enrolling a device for someone who doesn&apos;t track yet uses a seat.</span>}
            >
              <option value="">{users.data ? 'Choose a person…' : 'Loading people…'}</option>
              {[...(users.data ?? [])]
                .filter((u) => u.status === 'active')
                .sort(byName)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} · {u.email}
                    {u.tracking_enabled ? '' : ' (not tracking yet)'}
                  </option>
                ))}
            </SelectField>
          </div>
          {action.error?.code === 'seat_limit_reached' || action.error?.code === 'plan_upgrade_required' ? (
            <p role="alert">
              {action.error.code === 'seat_limit_reached' ? 'No seat is available for this person.' : 'Your plan needs an upgrade to add this person.'}{' '}
              <Link href="/admin/billing" style={{ color: 'var(--link-on-ink)' }}>
                Open billing →
              </Link>
            </p>
          ) : (
            <div style={{ color: '#fff' }}>
              <ActionError error={action.error} />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

const UPDATE_MODES: { value: AgentUpdateMode; label: string; detail: string }[] = [
  { value: 'prompt', label: 'People choose when', detail: 'The app says a new version is ready; people restart it when it suits them.' },
  { value: 'auto', label: 'Automatically', detail: 'The app installs it by itself, only while no session is running.' },
  { value: 'hold', label: 'Hold', detail: 'No updates are offered. Use it to test a release first, or when IT deploys the MSI.' },
];

/** How the desktop app updates in this organization (G10). Only signed releases ever install. */
function AppUpdates() {
  const res = useApi('admin:agent-updates', (signal) => rd.admin.agentUpdates(signal));
  const action = useAction();
  // Shows the choice at once; puts the old one back if saving fails.
  const set = async (mode: AgentUpdateMode) => {
    const before = res.data;
    res.mutate((prev) => (prev ? { ...prev, mode } : prev));
    const r = await action.run(() => rd.admin.setAgentUpdateMode(mode));
    res.mutate(() => r ?? before);
  };
  return (
    <Card title="App updates" subtitle={res.data?.latest_version ? `Latest version ${res.data.latest_version}` : 'No release published for this service yet'}>
      <Resource {...res} label="Loading update settings">
        {(u) => (
          <div className="stack" style={{ gap: 12 }}>
            <Segmented<AgentUpdateMode>
              legend="How the desktop app updates"
              name="agent-update-mode"
              value={u.mode}
              onChange={(m) => void set(m)}
              disabled={action.busy}
              options={UPDATE_MODES.map(({ value, label }) => ({ value, label }))}
            />
            <p className="small secondary">{UPDATE_MODES.find((m) => m.value === u.mode)!.detail} Only releases signed by RoundDigital install.</p>
            {u.versions.length ? (
              <p className="small">
                {u.versions.map((v, i) => (
                  <span key={v.version}>
                    {i ? ' · ' : ''}
                    <span className="mono">{v.version}</span> on {plural(v.devices, 'computer')}
                    {v.current ? '' : ' (behind)'}
                  </span>
                ))}
              </p>
            ) : null}
            <ActionError error={action.error} />
          </div>
        )}
      </Resource>
    </Card>
  );
}

export default function DevicesPage() {
  const { access, timezone: tz } = useMe();
  const devices = useApi(access.isAdmin ? 'admin:devices' : null, (signal) => rd.admin.devices(signal));
  const [enrolling, setEnrolling] = useState(false);
  const [revoking, setRevoking] = useState<DeviceDTO | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const revoke = useAction();
  if (!access.isAdmin) return <NoAccess what="Devices are managed by org admins." />;

  const all = devices.data ?? [];
  const active = all.filter((d) => d.credential_status === 'active');
  const behind = active.filter(isBehind).length;
  const missing = active.filter((d) => missingPermissions(d).length > 0).length;
  const revokedCount = all.length - active.length;

  const confirmRevoke = async () => {
    if (!revoking) return;
    const r = await revoke.run(() => rd.admin.revokeDevice(revoking.id));
    if (r) {
      devices.mutate((prev) =>
        prev?.map((d) => (d.id === revoking.id ? { ...d, credential_status: 'revoked', revoked_at: new Date().toISOString() } : d)),
      );
      setRevoking(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Admin · Agent fleet"
        title="Devices"
        description={
          devices.data
            ? `${active.length} enrolled · ${behind} behind on policy · ${plural(missing, 'device')} missing a permission`
            : 'Every enrolled desktop agent.'
        }
        actions={
          <Button variant="primary" onClick={() => setEnrolling(true)}>
            New enrollment code →
          </Button>
        }
      />
      {missing > 0 ? (
        <Banner tone="warn" title={`${plural(missing, 'device')} missing a permission`}>
          Minutes without permission are marked “no permission”, never as idle. The agent shows the person one banner with a link to fix it.
        </Banner>
      ) : null}
      <Card
        title="Enrolled devices"
        actions={
          revokedCount > 0 ? (
            <Button variant="link" aria-pressed={showRevoked} onClick={() => setShowRevoked((v) => !v)}>
              {showRevoked ? 'Hide revoked' : `Show ${revokedCount} revoked`}
            </Button>
          ) : undefined
        }
      >
        <Resource {...devices} label="Loading devices">
          {(list) => {
            const rows = list
              .filter((d) => showRevoked || d.credential_status === 'active')
              .sort((a, b) => a.user_name.localeCompare(b.user_name) || a.name.localeCompare(b.name));
            return rows.length === 0 ? (
              <Empty title="No devices enrolled yet">Create an enrollment code and enter it in the desktop agent on first run.</Empty>
            ) : (
              <TableBox label="Enrolled devices">
                <table className={tableClass} style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th scope="col">Person · device</th>
                      <th scope="col">OS · agent</th>
                      <th scope="col">Last sync</th>
                      <th scope="col">Policy</th>
                      <th scope="col">Permissions</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => {
                      const revoked = d.credential_status === 'revoked';
                      const notes = [d.clock_skew_detected ? 'clock skew' : null, d.sequence_gaps > 0 ? plural(d.sequence_gaps, 'sequence gap') : null].filter(Boolean);
                      return (
                        <tr key={d.id} style={revoked ? { color: 'var(--text-3)' } : undefined}>
                          <td>
                            <span style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontWeight: 600 }}>{d.user_name}</span>
                              <span className="small muted">{d.name}</span>
                            </span>
                          </td>
                          <td className="small">
                            {OS_LABEL[d.os]} {d.os_version}
                            <br />
                            <span className="mono muted">{d.agent_version}</span>
                          </td>
                          <td className="small">
                            {formatRelative(d.last_sync_at, tz)}
                            <br />
                            <span className="muted">
                              seen {formatRelative(d.last_seen_at, tz)} · enrolled {formatDateTime(d.enrolled_at, tz).replace(/, \d\d:\d\d$/, '')}
                            </span>
                          </td>
                          <td>
                            {revoked ? (
                              <span className="muted">—</span>
                            ) : isBehind(d) ? (
                              <Badge tone="warn">
                                {d.applied_policy_revision === null ? 'None applied' : `Rev ${d.applied_policy_revision}`} · behind
                              </Badge>
                            ) : (
                              <Badge>Rev {d.applied_policy_revision}</Badge>
                            )}
                          </td>
                          <td>
                            <Permissions d={d} />
                            {notes.length ? <div className="small muted">{notes.join(' · ')}</div> : null}
                          </td>
                          <td>{revoked ? <Badge>Revoked</Badge> : <Badge tone="solid">Active</Badge>}</td>
                          <td style={{ textAlign: 'right' }}>
                            {!revoked ? (
                              <Button size="sm" variant="danger" onClick={() => setRevoking(d)} aria-label={`Revoke ${d.name} (${d.user_name})`}>
                                Revoke
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableBox>
            );
          }}
        </Resource>
      </Card>

      <AppUpdates />
      {access.entitlements.includes('mdm') ? <MdmDeployment tz={tz} /> : null}
      <EnrollDialog
        open={enrolling}
        onClose={() => {
          setEnrolling(false);
          devices.reload();
        }}
      />
      <Dialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        size="sm"
        title={`Revoke ${revoking?.name ?? 'device'}?`}
        description={`${revoking?.user_name ?? 'The person'}'s agent on this device stops collecting at its next contact and shows why. Records already received stay. This can't be undone — the device needs a new enrollment code.`}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="primary" onClick={confirmRevoke} disabled={revoke.busy}>
              {revoke.busy ? 'Revoking…' : 'Revoke device'}
            </Button>
          </>
        }
      >
        <ActionError error={revoke.error} />
      </Dialog>
    </>
  );
}
