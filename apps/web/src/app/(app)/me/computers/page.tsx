'use client';

import { useEffect, useState } from 'react';
import { enrollmentLink, type AgentDownload, type EnrollmentCodeResponse } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatCountdown, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { t, type MessageKey } from '@/lib/i18n';

const OS_LABEL = { macos: 'macOS', windows: 'Windows', linux: 'Linux' } as const;
const KNOWN_PERMISSIONS = new Set(['input_monitoring', 'screen_recording', 'accessibility']);

/** The computer this page is open on, best guess, to put its installer first. */
function useThisOs(): AgentDownload['os'] | null {
  const [os, setOs] = useState<AgentDownload['os'] | null>(null);
  useEffect(() => {
    const ua = navigator.userAgent;
    // Read once after mount so the server render and the first client render match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOs(/Mac/.test(ua) ? 'macos' : /Windows/.test(ua) ? 'windows' : null);
  }, []);
  return os;
}

function Expiry({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Date.parse(at) - now;
  return left > 0 ? <>{t('comp.expires', { left: formatCountdown(left) })}</> : <strong>{t('comp.expired')}</strong>;
}

function Download() {
  const res = useApi('agent:downloads', (signal) => rd.my.agentDownloads(signal));
  const os = useThisOs();
  return (
    <Card title={t('comp.install')} subtitle={t('comp.installSub')}>
      <Resource {...res} label={t('comp.loadingDownloads')}>
        {(d) =>
          !d.available ? (
            <Empty title={t('comp.notPublished')}>{t('comp.notPublishedBody')}</Empty>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[...d.files]
                .sort((a, b) => Number(b.os === os) - Number(a.os === os))
                .map((f) => (
                  <li key={f.url} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>
                      <strong>{f.label}</strong> <span className="small muted">· {f.kind}</span> {f.os === os && f.kind !== 'MSI' ? <Badge tone="solid">{t('comp.thisComputer')}</Badge> : null}
                    </span>
                    <a href={f.url} rel="noopener">
                      {t('comp.download', { os: OS_LABEL[f.os], kind: f.kind === 'MSI' ? 'MSI' : f.kind.toLowerCase(), version: d.version ?? '' })}
                    </a>
                  </li>
                ))}
            </ul>
          )
        }
      </Resource>
    </Card>
  );
}

function Connect() {
  const { me } = useMe();
  const [code, setCode] = useState<EnrollmentCodeResponse | null>(null);
  const [server, setServer] = useState('');
  const action = useAction();
  useEffect(() => {
    // The app talks to the same address this page is served from (it forwards /v1 to the API).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setServer(window.location.origin);
  }, []);
  if (!me.user.tracking_enabled) {
    return (
      <Banner tag="NOTE" title={t('day.trackingOffTitle')}>
        {t('comp.trackingOffBody')}
      </Banner>
    );
  }
  const get = async () => {
    const r = await action.run(() => rd.my.enrollmentCode());
    if (r) setCode(r);
  };
  const link = code && server ? enrollmentLink(server, code.code) : null;
  return (
    <Card title={t('comp.connect')} subtitle={t('comp.connectSub')}>
      {!code ? (
        <div>
          <Button variant="primary" onClick={get} disabled={action.busy}>
            {action.busy ? t('comp.getting') : t('comp.getCode')}
          </Button>
        </div>
      ) : (
        <>
          <p>
            {t('comp.withLinkBefore')} <a href={link!}>{t('comp.withLink')}</a>
            {t('comp.withLinkAfter')}
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr auto', gap: '10px 16px', alignItems: 'center', margin: 0 }}>
            <dt className="small muted">{t('comp.server')}</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {server}
            </dd>
            <CopyButton text={server} label={t('comp.copyAddress')} />
            <dt className="small muted">{t('comp.code')}</dt>
            <dd className="mono" style={{ margin: 0, fontSize: 22, letterSpacing: '0.12em' }} aria-label={t('comp.codeLabel')}>
              {code.code}
            </dd>
            <CopyButton text={code.code} label={t('comp.copyCode')} />
          </dl>
          <p className="small secondary">
            <Expiry at={code.expires_at} /> {t('comp.another')} <CopyButton text={link!} label={t('comp.copyLink')} /> {t('comp.openThere')}
          </p>
        </>
      )}
      <ActionError error={action.error} />
    </Card>
  );
}

function MyComputers() {
  const { timezone: tz } = useMe();
  const res = useApi('me:devices', (signal) => rd.my.devices(signal));
  return (
    <Card title={t('comp.yours')} subtitle={t('comp.yoursSub')}>
      <Resource {...res} label={t('comp.loading')}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={t('comp.none')} />
          ) : (
            <TableBox label={t('comp.yours')}>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th scope="col">{t('comp.col.computer')}</th>
                    <th scope="col">{t('comp.col.app')}</th>
                    <th scope="col">{t('comp.col.synced')}</th>
                    <th scope="col">{t('comp.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => {
                    const denied = Object.entries(d.permissions)
                      .filter(([, v]) => v === 'denied')
                      .map(([k]) => (KNOWN_PERMISSIONS.has(k) ? t(`comp.perm.${k}` as MessageKey) : k.replace(/_/g, ' ')));
                    return (
                      <tr key={d.id}>
                        <th scope="row">
                          {d.name}
                          <span className="small muted">
                            {' '}
                            · {OS_LABEL[d.os]} {d.os_version}
                          </span>
                        </th>
                        <td className="small mono">v{d.agent_version}</td>
                        <td className="small">{d.last_sync_at ? formatRelative(d.last_sync_at, tz) : t('time.never')}</td>
                        <td>
                          {d.credential_status === 'revoked' ? (
                            <Badge>{t('comp.removed')}</Badge>
                          ) : denied.length ? (
                            <Badge tone="warn">{t('comp.needs', { what: denied.join(', ') })}</Badge>
                          ) : (
                            <Badge tone="solid">{t('comp.connected')}</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableBox>
          )
        }
      </Resource>
    </Card>
  );
}

/** Self-service setup (G10, G12): download the app, connect it with your own code, see your computers. */
export default function MyComputersPage() {
  return (
    <>
      <PageHeader
        eyebrow={t('comp.eyebrow')}
        title={t('comp.title')}
        description={t('comp.description')}
      />
      <Download />
      <Connect />
      <MyComputers />
    </>
  );
}
