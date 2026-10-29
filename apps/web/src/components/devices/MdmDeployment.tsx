'use client';

import { useState, type FormEvent } from 'react';
import type { DeploymentKeyCreated, DeploymentKeyDTO } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { DEPLOYMENT_FILE_PATHS, deploymentJson, macosScript, windowsScript } from '@/lib/branding';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';

function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The key, once, with the files IT deploys. */
function NewKey({ k, onDone }: { k: DeploymentKeyCreated; onDone: () => void }) {
  return (
    <Banner
      tone="ink"
      title={`“${k.name}” is ready. Download the files now: the key isn't shown again.`}
      actions={
        <Button size="sm" variant="quiet" onClick={onDone}>
          I&apos;ve saved them
        </Button>
      }
    >
      <span className="stack" style={{ gap: 8, marginTop: 6 }}>
        <span className="mono small" style={{ overflowWrap: 'anywhere' }}>
          {k.key}
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => download('deployment.json', deploymentJson(k.server_url, k.key), 'application/json')}>
            deployment.json
          </Button>
          <Button size="sm" onClick={() => download('rdtrack-deploy-macos.sh', macosScript(k.server_url, k.key))}>
            macOS script
          </Button>
          <Button size="sm" onClick={() => download('Install-RDTrack.ps1', windowsScript(k.server_url, k.key))}>
            Windows script
          </Button>
          <CopyButton text={k.key} label="Copy the key" />
        </span>
      </span>
    </Banner>
  );
}

/**
 * Deploying the desktop app with MDM (G26, Pro). IT installs the app and a deployment file
 * with this key; on first launch the person enters their work email and gets a one-time
 * code by email. The key alone never connects a computer.
 */
export function MdmDeployment({ tz }: { tz: string }) {
  const keys = useApi('admin:deployment-keys', (signal) => rd.admin.deploymentKeys(signal));
  const action = useAction();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<DeploymentKeyCreated | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => rd.admin.createDeploymentKey(name.trim()));
    if (!r) return;
    setCreated(r);
    setName('');
    keys.reload();
  };
  const revoke = async (k: DeploymentKeyDTO) => {
    if (await action.run(() => rd.admin.revokeDeploymentKey(k.id))) keys.reload();
  };
  return (
    <Card title="Deploy with MDM" subtitle="Jamf, Kandji, Intune or Group Policy">
      <p className="small secondary">
        Install the app with your MDM, plus a deployment file with a key from here: <span className="mono">{DEPLOYMENT_FILE_PATHS.macos}</span> on
        macOS, <span className="mono">{DEPLOYMENT_FILE_PATHS.windows}</span> on Windows. On first launch people enter their work email and get a
        one-time code by email, so nobody hands out codes and the key alone never connects a computer. Nothing is recorded until they start a
        session.
      </p>
      {created ? <NewKey k={created} onDone={() => setCreated(null)} /> : null}
      <form onSubmit={create} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <TextField label="Key name" placeholder="e.g. Intune, Jamf" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" disabled={!name.trim() || action.busy}>
          Create a deployment key
        </Button>
      </form>
      <ActionError error={action.error} />
      <Resource {...keys} label="Loading deployment keys">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No deployment keys yet" />
          ) : (
            <TableBox label="Deployment keys">
              <table className={tableClass} style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Key</th>
                    <th scope="col">Last used</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((k) => (
                    <tr key={k.id}>
                      <td>
                        {k.name} {k.revoked_at ? <Badge>Revoked</Badge> : null}
                        <span className="small muted" style={{ display: 'block' }}>
                          {k.created_by_name ? `${k.created_by_name} · ` : ''}
                          {formatDateTime(k.created_at, tz)}
                        </span>
                      </td>
                      <td className="mono small">…{k.hint}</td>
                      <td className="small">{k.last_used_at ? formatDateTime(k.last_used_at, tz) : 'Never'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {k.revoked_at ? null : (
                          <Button size="sm" variant="quiet" onClick={() => void revoke(k)} disabled={action.busy}>
                            Revoke
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
  );
}
