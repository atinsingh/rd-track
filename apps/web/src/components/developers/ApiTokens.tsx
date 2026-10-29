'use client';

import { useState } from 'react';
import { API_TOKEN_MAX_DAYS, type ApiTokenCreated, type ApiTokenDTO, type ApiTokenKind } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Segmented, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from './developers.module.css';

const DAY = 24 * 3600_000;
const LIFETIMES: Record<ApiTokenKind, number[]> = { organization: [30, 90, 180, 365], personal: [30, 60, 90] };
const lifetime = (d: number) => (d === 365 ? '1 year' : `${d} days`);

function expiry(t: ApiTokenDTO, tz: string, now: number): { text: string; soon: boolean } {
  const left = Date.parse(t.expires_at) - now;
  if (t.expired || left <= 0) return { text: 'Expired', soon: true };
  if (left < 14 * DAY) return { text: `in ${Math.max(1, Math.ceil(left / DAY))} days`, soon: true };
  return { text: formatDateTime(t.expires_at, tz).replace(/, \d\d:\d\d$/, ''), soon: false };
}

function NewToken({ open, admin, onClose, onCreated }: { open: boolean; admin: boolean; onClose: () => void; onCreated: (t: ApiTokenCreated) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ApiTokenKind>(admin ? 'organization' : 'personal');
  const [write, setWrite] = useState<'read' | 'write'>('read');
  const [payroll, setPayroll] = useState(false);
  const [days, setDays] = useState(90);
  const action = useAction();
  const close = () => {
    setName('');
    setWrite('read');
    setPayroll(false);
    setDays(90);
    action.reset();
    onClose();
  };
  const create = async () => {
    const scopes = kind === 'personal' ? undefined : (['read', ...(write === 'write' ? ['write'] : []), ...(payroll ? ['payroll'] : [])] as ('read' | 'write' | 'payroll')[]);
    const t = await action.run(() => rd.apiTokens.create({ name: name.trim(), kind, scopes, expires_in_days: Math.min(days, API_TOKEN_MAX_DAYS[kind]) }));
    if (t) {
      onCreated(t);
      close();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New API token"
      eyebrow="Developers"
      description={
        kind === 'organization'
          ? 'It acts as you: it sees what you can see, on the endpoints in the API reference. Give it only the access the integration needs.'
          : 'Read-only, and only your own data: your time, timesheets, time off and insights.'
      }
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={action.busy || !name.trim()}>
            {action.busy ? 'Creating…' : 'Create token'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <TextField label="Name" placeholder={kind === 'organization' ? 'Payroll sync' : 'My timesheet export'} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        {admin ? (
          <Segmented<ApiTokenKind>
            legend="Kind"
            name="token-kind"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setDays((d) => Math.min(d, API_TOKEN_MAX_DAYS[k]));
            }}
            options={[
              { value: 'organization', label: 'Organization' },
              { value: 'personal', label: 'Personal' },
            ]}
          />
        ) : null}
        {kind === 'organization' ? (
          <>
            <Segmented<'read' | 'write'>
              legend="Access"
              name="token-access"
              value={write}
              onChange={setWrite}
              options={[
                { value: 'read', label: 'Read' },
                { value: 'write', label: 'Read and write' },
              ]}
            />
            <Checkbox label="Payroll" hint="Pay rates and payroll files. Leave off unless the integration runs payroll." checked={payroll} onChange={(e) => setPayroll(e.target.checked)} />
          </>
        ) : null}
        <SelectField label="Expires after" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          {LIFETIMES[kind].map((d) => (
            <option key={d} value={d}>
              {lifetime(d)}
            </option>
          ))}
        </SelectField>
        <ActionError error={action.error} />
      </div>
    </Dialog>
  );
}

/** Shown once, right after creation: the secret itself. */
function Reveal({ token, onDone }: { token: ApiTokenCreated; onDone: () => void }) {
  return (
    <Card tone="ink" className={s.reveal}>
      <div className={s.revealHead}>
        <h2 className={s.revealTitle}>“{token.name}” is ready — copy the token now</h2>
        <span className="small">It won&apos;t be shown again. We only keep a hash.</span>
      </div>
      <div className={s.revealRow}>
        <code className={s.secret}>{token.token}</code>
        <CopyButton text={token.token} label="Copy token" variant="inverse" />
        <Button variant="quiet" className={s.onInk} onClick={onDone}>
          I&apos;ve stored it
        </Button>
      </div>
    </Card>
  );
}

/**
 * The tokens table (F5). `admin`: every token in the organization, organization or
 * personal. `personal`: the signed-in person's own personal tokens.
 */
export function ApiTokens({ mode }: { mode: 'admin' | 'personal' }) {
  const { me, timezone: tz } = useMe();
  const tokens = useApi('api-tokens', (signal) => rd.apiTokens.list(signal));
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenDTO | null>(null);
  const action = useAction();
  // Fixed for the life of the page; "in N days" needs no ticking.
  const [now] = useState(() => Date.now());
  const revoke = async () => {
    if (!revoking) return;
    if (await action.run(() => rd.apiTokens.revoke(revoking.id))) {
      tokens.mutate((prev) => prev?.filter((t) => t.id !== revoking.id));
      setRevoking(null);
    }
  };
  return (
    <>
      {created ? <Reveal token={created} onDone={() => setCreated(null)} /> : null}
      <Card
        title={mode === 'admin' ? 'Tokens' : 'API tokens'}
        subtitle={mode === 'personal' ? 'Read your own time, timesheets and insights from a script or spreadsheet' : undefined}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New token →
          </Button>
        }
      >
        <Resource {...tokens} label="Loading tokens">
          {(all) => {
            const list = mode === 'admin' ? all : all.filter((t) => t.kind === 'personal' && t.owner_id === me.user.id);
            return list.length === 0 ? (
              <Empty title="No tokens yet">{mode === 'admin' ? 'Create one for each integration, so each can be revoked on its own.' : 'Create one to read your own data with the API.'}</Empty>
            ) : (
              <TableBox label="API tokens">
                <table className={tableClass} style={{ minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Access</th>
                      <th scope="col">Last used</th>
                      <th scope="col">Expires</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((t) => {
                      const ex = expiry(t, tz, now);
                      return (
                        <tr key={t.id}>
                          <th scope="row">
                            <span className={s.name}>{t.name}</span>
                            <span className="small muted">
                              {t.kind === 'organization' ? `Organization · created by ${t.owner_name}` : `Personal · ${t.owner_name}`}
                            </span>
                          </th>
                          <td>
                            <span className={s.chips}>
                              {t.kind === 'personal' ? <Badge>read · own</Badge> : t.scopes.map((sc) => <Badge key={sc}>{sc}</Badge>)}
                            </span>
                          </td>
                          <td className="small">{t.last_used_at ? formatRelative(t.last_used_at, tz) : 'Never'}</td>
                          <td className={ex.soon ? `small ${s.soon}` : 'small'}>{ex.text}</td>
                          <td style={{ textAlign: 'right' }}>
                            <Button size="sm" variant="quiet" aria-label={`Revoke ${t.name}`} onClick={() => setRevoking(t)}>
                              Revoke
                            </Button>
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
      <NewToken
        open={creating}
        admin={mode === 'admin'}
        onClose={() => setCreating(false)}
        onCreated={(t) => {
          setCreated(t);
          const { token: _secret, ...dto } = t;
          void _secret;
          tokens.mutate((prev) => [dto, ...(prev ?? [])]);
        }}
      />
      <Dialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
          action.reset();
        }}
        size="sm"
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="Calls with it are refused from now on. The integration needs a new token."
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={revoke} disabled={action.busy}>
              {action.busy ? 'Revoking…' : 'Revoke token'}
            </Button>
          </>
        }
      >
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}
