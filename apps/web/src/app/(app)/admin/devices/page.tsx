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
import { browserList, EXTENSION_IDS, STORE_NAMES } from '@/lib/browsers';
import { byName } from '@/lib/format';
import { t, tPlural, type MessageKey } from '@/lib/i18n';
import { currentLocale } from '@/lib/locale';
import { useMe } from '@/lib/me';
import { formatCountdown, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from '../admin.module.css';

const OS_LABEL: Record<DeviceDTO['os'], string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const PERMS: { key: string; label: MessageKey }[] = [
  { key: 'input_monitoring', label: 'adm.dev.permInput' },
  { key: 'screen_recording', label: 'adm.dev.permScreen' },
  { key: 'accessibility', label: 'adm.dev.permAccess' },
];

/** "27 Oct 2026": the day, without the time. */
const dayOnly = (iso: string, tz: string) =>
  new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(iso));

function isBehind(d: DeviceDTO): boolean {
  return d.credential_status === 'active' && (d.applied_policy_revision === null || d.applied_policy_revision < d.current_policy_revision);
}
function missingPermissions(d: DeviceDTO): string[] {
  return PERMS.filter((p) => d.permissions[p.key] === 'denied').map((p) => t(p.label));
}

function permText(state: PermissionState | undefined): string {
  switch (state) {
    case 'granted':
      return '✓';
    case 'denied':
      return t('adm.dev.missing');
    case 'not_required':
      return '—';
    default:
      return '?';
  }
}
const permSr = (st: string) =>
  ['granted', 'denied', 'not_required'].includes(st) ? t(`adm.dev.sr.${st}` as MessageKey) : t('adm.dev.sr.unknown');

function Permissions({ d }: { d: DeviceDTO }) {
  const shown = PERMS.filter((p) => d.permissions[p.key] !== undefined && !(p.key === 'accessibility' && d.permissions[p.key] === 'not_required'));
  if (shown.length === 0) return <span className={s.perm}>{t('adm.dev.notReported')}</span>;
  const missing = missingPermissions(d).length > 0;
  return (
    <span className={missing ? s.permWarn : s.perm}>
      {shown.map((p, i) => {
        const st = d.permissions[p.key];
        return (
          <span key={p.key}>
            {i > 0 ? ' · ' : ''}
            <span aria-hidden="true">
              {t(p.label)} {permText(st)}
            </span>
            <span className="visually-hidden">{t('adm.dev.permSr', { name: t(p.label), state: permSr(st ?? 'unknown') })}</span>
          </span>
        );
      })}
    </span>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Date.parse(expiresAt) - now;
  return left > 0 ? (
    <>
      {t('adm.dev.expiresIn')}{' '}
      <strong className="mono" style={{ color: '#fff' }}>
        {formatCountdown(left)}
      </strong>
    </>
  ) : (
    <strong style={{ color: '#fff' }}>{t('adm.dev.expired')}</strong>
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
      eyebrow={t('adm.dev.codeEyebrow')}
      title={code ? t('adm.dev.codeFor', { name: person?.display_name ?? t('adm.dev.thisPerson') }) : t('adm.dev.newCode')}
      description={code ? undefined : t('adm.dev.codeIntro')}
      footer={
        code ? (
          <>
            <CopyButton text={code.code} label={t('adm.dev.copyCode')} variant="inverse" />
            <CopyButton text={enrollmentLink(window.location.origin, code.code)} label={t('adm.dev.copyLink')} variant="inverse" />
            <Button variant="quiet" onClick={close}>
              {t('adm.dev.done')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={!userId || action.busy} onClick={create}>
              {action.busy ? t('adm.dev.creating') : t('adm.dev.createCode')}
            </Button>
          </>
        )
      }
    >
      {code ? (
        <>
          <div className={s.code} aria-label={t('adm.dev.codeEyebrow')}>
            {code.code}
          </div>
          <p role="timer" aria-live="off">
            {t('adm.dev.singleUse')} <Countdown expiresAt={code.expires_at} />. {t('adm.dev.shareWith', { name: person?.display_name ?? t('adm.dev.them') })}
          </p>
          <p className="small" style={{ color: 'var(--ink-muted)' }}>
            {t('adm.dev.linkNote')}
          </p>
          <p className="small" style={{ color: 'var(--ink-muted)' }}>
            {t('adm.dev.firstRun')}
          </p>
        </>
      ) : (
        <>
          <div style={{ color: 'var(--text)' }}>
            <SelectField
              label={<span style={{ color: '#fff' }}>{t('adm.dev.person')}</span>}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={!users.data}
              hint={<span style={{ color: 'var(--ink-muted)' }}>{t('adm.dev.seatHint')}</span>}
            >
              <option value="">{users.data ? t('adm.dev.choosePerson') : t('adm.dev.loadingPeople')}</option>
              {[...(users.data ?? [])]
                .filter((u) => u.status === 'active')
                .sort(byName)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} · {u.email}
                    {u.tracking_enabled ? '' : t('adm.dev.notTrackingYet')}
                  </option>
                ))}
            </SelectField>
          </div>
          {action.error?.code === 'seat_limit_reached' || action.error?.code === 'plan_upgrade_required' ? (
            <p role="alert">
              {action.error.code === 'seat_limit_reached' ? t('adm.dev.noSeat') : t('adm.dev.needUpgrade')}{' '}
              <Link href="/admin/billing" style={{ color: 'var(--link-on-ink)' }}>
                {t('adm.dev.openBilling')}
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

/** Website domains (Pro): how the extension gets to people's browsers, and how many have it. */
function BrowserExtension({ devices }: { devices: DeviceDTO[] | undefined }) {
  const downloads = useApi('agent:downloads', (signal) => rd.my.agentDownloads(signal));
  const active = (devices ?? []).filter((d) => d.credential_status === 'active');
  const withExt = active.filter((d) => d.browser_extensions.length > 0).length;
  const ids: [MessageKey, string][] = [
    ['adm.dev.ext.chromium', EXTENSION_IDS.chromium],
    ['adm.dev.ext.firefox', EXTENSION_IDS.firefox],
  ];
  return (
    <Card title={t('adm.dev.ext.title')} subtitle={t('adm.dev.ext.sub')}>
      <div className="stack" style={{ gap: 10 }}>
        <p style={{ margin: 0 }}>{t('adm.dev.ext.body')}</p>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr) auto', gap: '8px 16px', alignItems: 'center', margin: 0 }}>
          {ids.map(([label, id]) => (
            <div key={id} style={{ display: 'contents' }}>
              <dt className="small muted">{t(label)}</dt>
              <dd className="mono small" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                {id}
              </dd>
              <CopyButton text={id} />
            </div>
          ))}
        </dl>
        {downloads.data?.extensions.length ? (
          <p className="small" style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {downloads.data.extensions.map((s) => (
              <a key={s.browser} href={s.url} rel="noopener" target="_blank">
                {t('adm.dev.ext.store')} · {STORE_NAMES[s.browser]}
              </a>
            ))}
          </p>
        ) : null}
        {devices && active.length ? (
          <p className="small secondary" style={{ margin: 0 }}>
            {t('adm.dev.ext.count', { n: withExt, total: active.length })}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

const UPDATE_MODES: AgentUpdateMode[] = ['prompt', 'auto', 'hold'];
const modeLabel = (m: AgentUpdateMode) => t(`adm.dev.mode.${m}`);
const modeDetail = (m: AgentUpdateMode) => t(`adm.dev.mode.${m}.detail`);

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
    <Card title={t('adm.dev.updates')} subtitle={res.data?.latest_version ? t('adm.dev.latest', { version: res.data.latest_version }) : t('adm.dev.noRelease')}>
      <Resource {...res} label={t('adm.dev.loadingUpdates')}>
        {(u) => (
          <div className="stack" style={{ gap: 12 }}>
            <Segmented<AgentUpdateMode>
              legend={t('adm.dev.howUpdates')}
              name="agent-update-mode"
              value={u.mode}
              onChange={(m) => void set(m)}
              disabled={action.busy}
              options={UPDATE_MODES.map((value) => ({ value, label: modeLabel(value) }))}
            />
            <p className="small secondary">
              {modeDetail(u.mode)} {t('adm.dev.signedOnly')}
            </p>
            {u.versions.length ? (
              <p className="small">
                {u.versions.map((v, i) => (
                  <span key={v.version}>
                    {i ? ' · ' : ''}
                    <span className="mono">{v.version}</span> {tPlural(v.devices, 'adm.dev.onComputers.one', 'adm.dev.onComputers.other')}
                    {v.current ? '' : t('adm.dev.behindSuffix')}
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
  if (!access.isAdmin) return <NoAccess what={t('adm.dev.noAccess')} />;

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
        eyebrow={t('adm.dev.eyebrow')}
        title={t('adm.dev.title')}
        description={
          devices.data
            ? tPlural(missing, 'adm.dev.summary.one', 'adm.dev.summary.other', { enrolled: active.length, behind })
            : t('adm.dev.everyAgent')
        }
        actions={
          <Button variant="primary" onClick={() => setEnrolling(true)}>
            {t('adm.dev.newCodeAction')}
          </Button>
        }
      />
      {missing > 0 ? (
        <Banner tone="warn" title={tPlural(missing, 'adm.dev.missingTitle.one', 'adm.dev.missingTitle.other')}>
          {t('adm.dev.missingBody')}
        </Banner>
      ) : null}
      <Card
        title={t('adm.dev.enrolled')}
        actions={
          revokedCount > 0 ? (
            <Button variant="link" aria-pressed={showRevoked} onClick={() => setShowRevoked((v) => !v)}>
              {showRevoked ? t('adm.dev.hideRevoked') : t('adm.dev.showRevoked', { n: revokedCount })}
            </Button>
          ) : undefined
        }
      >
        <Resource {...devices} label={t('adm.dev.loading')}>
          {(list) => {
            const rows = list
              .filter((d) => showRevoked || d.credential_status === 'active')
              .sort((a, b) => a.user_name.localeCompare(b.user_name) || a.name.localeCompare(b.name));
            return rows.length === 0 ? (
              <Empty title={t('adm.dev.none')}>{t('adm.dev.noneBody')}</Empty>
            ) : (
              <TableBox label={t('adm.dev.enrolled')}>
                <table className={tableClass} style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.dev.colPerson')}</th>
                      <th scope="col">{t('adm.dev.colOs')}</th>
                      <th scope="col">{t('adm.dev.colSync')}</th>
                      <th scope="col">{t('adm.dev.colPolicy')}</th>
                      <th scope="col">{t('adm.dev.colPerms')}</th>
                      <th scope="col">{t('adm.dev.colStatus')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.dev.colActions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => {
                      const revoked = d.credential_status === 'revoked';
                      const notes = [
                        d.clock_skew_detected ? t('adm.dev.clockSkew') : null,
                        d.sequence_gaps > 0 ? tPlural(d.sequence_gaps, 'adm.dev.gaps.one', 'adm.dev.gaps.other') : null,
                        !revoked && d.browser_extensions.length ? t('adm.dev.browsers', { list: browserList(d.browser_extensions) }) : null,
                      ].filter(Boolean);
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
                              {t('adm.dev.seenEnrolled', { seen: formatRelative(d.last_seen_at, tz), enrolled: dayOnly(d.enrolled_at, tz) })}
                            </span>
                          </td>
                          <td>
                            {revoked ? (
                              <span className="muted">—</span>
                            ) : isBehind(d) ? (
                              <Badge tone="warn">
                                {d.applied_policy_revision === null ? t('adm.dev.noneApplied') : t('adm.dev.rev', { n: d.applied_policy_revision })} · {t('adm.dev.behind')}
                              </Badge>
                            ) : (
                              <Badge>{t('adm.dev.rev', { n: d.applied_policy_revision ?? '' })}</Badge>
                            )}
                          </td>
                          <td>
                            <Permissions d={d} />
                            {notes.length ? <div className="small muted">{notes.join(' · ')}</div> : null}
                          </td>
                          <td>{revoked ? <Badge>{t('adm.dev.revoked')}</Badge> : <Badge tone="solid">{t('adm.dev.active')}</Badge>}</td>
                          <td style={{ textAlign: 'right' }}>
                            {!revoked ? (
                              <Button size="sm" variant="danger" onClick={() => setRevoking(d)} aria-label={t('adm.dev.revokeLabel', { device: d.name, person: d.user_name })}>
                                {t('adm.dev.revoke')}
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
      {access.entitlements.includes('domains') ? <BrowserExtension devices={devices.data} /> : null}
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
        title={t('adm.dev.revokeTitle', { device: revoking?.name ?? t('adm.dev.device') })}
        description={t('adm.dev.revokeBody', { person: revoking?.user_name ?? t('adm.dev.thePerson') })}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={confirmRevoke} disabled={revoke.busy}>
              {revoke.busy ? t('adm.dev.revoking') : t('adm.dev.revokeDevice')}
            </Button>
          </>
        }
      >
        <ActionError error={revoke.error} />
      </Dialog>
    </>
  );
}
