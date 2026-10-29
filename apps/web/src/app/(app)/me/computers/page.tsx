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

const OS_LABEL = { macos: 'macOS', windows: 'Windows', linux: 'Linux' } as const;

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
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Date.parse(at) - now;
  return left > 0 ? <>Works once, for the next {formatCountdown(left)}.</> : <strong>This code has expired. Get a new one.</strong>;
}

function Download() {
  const res = useApi('agent:downloads', (signal) => rd.my.agentDownloads(signal));
  const os = useThisOs();
  return (
    <Card title="1. Install Track" subtitle="The app sits in your menu bar or system tray. It records nothing until you start a session.">
      <Resource {...res} label="Loading downloads">
        {(d) =>
          !d.available ? (
            <Empty title="Installers aren't published yet">Ask your org admin for the Track installer for your computer.</Empty>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[...d.files]
                .sort((a, b) => Number(b.os === os) - Number(a.os === os))
                .map((f) => (
                  <li key={f.url} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>
                      <strong>{f.label}</strong> <span className="small muted">· {f.kind}</span> {f.os === os && f.kind !== 'MSI' ? <Badge tone="solid">This computer</Badge> : null}
                    </span>
                    <a href={f.url} rel="noopener">
                      Download {OS_LABEL[f.os]} {f.kind === 'MSI' ? 'MSI' : f.kind.toLowerCase()} (v{d.version})
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
      <Banner tag="NOTE" title="Tracking is off for your account">
        There&apos;s nothing to connect, so nothing is collected about you. An org admin can turn tracking on.
      </Banner>
    );
  }
  const get = async () => {
    const r = await action.run(() => rd.my.enrollmentCode());
    if (r) setCode(r);
  };
  const link = code && server ? enrollmentLink(server, code.code) : null;
  return (
    <Card title="2. Connect it" subtitle="A one-time code links one computer to you. Get a new one for each computer.">
      {!code ? (
        <div>
          <Button variant="primary" onClick={get} disabled={action.busy}>
            {action.busy ? 'Getting a code…' : 'Get a connection code'}
          </Button>
        </div>
      ) : (
        <>
          <p>
            With Track installed on this computer, <a href={link!}>open it with this link</a>: the server address and code are filled in, and you press
            Connect. Or type them in yourself:
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr auto', gap: '10px 16px', alignItems: 'center', margin: 0 }}>
            <dt className="small muted">Server address</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {server}
            </dd>
            <CopyButton text={server} label="Copy address" />
            <dt className="small muted">Code</dt>
            <dd className="mono" style={{ margin: 0, fontSize: 22, letterSpacing: '0.12em' }} aria-label="Connection code">
              {code.code}
            </dd>
            <CopyButton text={code.code} label="Copy code" />
          </dl>
          <p className="small secondary">
            <Expiry at={code.expires_at} /> Connecting on another computer? <CopyButton text={link!} label="Copy the link" /> and open it there.
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
    <Card title="Your computers" subtitle="Each one shows here once it's connected. Only an org admin can remove one.">
      <Resource {...res} label="Loading your computers">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No computers connected yet" />
          ) : (
            <TableBox label="Your computers">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th scope="col">Computer</th>
                    <th scope="col">App</th>
                    <th scope="col">Last synced</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => {
                    const denied = Object.entries(d.permissions).filter(([, v]) => v === 'denied').map(([k]) => k.replace(/_/g, ' '));
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
                        <td className="small">{d.last_sync_at ? formatRelative(d.last_sync_at, tz) : 'Never'}</td>
                        <td>
                          {d.credential_status === 'revoked' ? (
                            <Badge>Removed</Badge>
                          ) : denied.length ? (
                            <Badge tone="warn">Needs {denied.join(', ')}</Badge>
                          ) : (
                            <Badge tone="solid">Connected</Badge>
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
        eyebrow="Employee · Computers"
        title="My computers"
        description="Install Track and connect it yourself. You choose when it records: nothing is collected until you start a session."
      />
      <Download />
      <Connect />
      <MyComputers />
    </>
  );
}
