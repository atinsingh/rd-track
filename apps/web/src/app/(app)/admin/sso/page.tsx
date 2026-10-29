'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { SSO_ERRORS, type ScimTokenDTO, type SsoErrorCode, type SsoSettings } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, formGridClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi, type ApiResource } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

type Res = ApiResource<SsoSettings>;

/** Step 1: the provider's details, and what to paste into it. */
function Provider({ res, settings }: { res: Res; settings: SsoSettings }) {
  const c = settings.connection;
  const [f, setF] = useState({ issuer: c?.issuer ?? '', client_id: c?.client_id ?? '', client_secret: '' });
  const action = useAction();
  const dirty = !c || f.issuer !== c.issuer || f.client_id !== c.client_id || f.client_secret !== '';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() =>
      rd.admin.saveSsoConnection({ issuer: f.issuer.trim(), client_id: f.client_id.trim(), ...(f.client_secret ? { client_secret: f.client_secret } : {}) }),
    );
    if (r) {
      res.mutate(() => r);
      setF((x) => ({ ...x, client_secret: '' }));
    }
  };
  const remove = async () => {
    const r = await action.run(() => rd.admin.deleteSsoConnection());
    if (r) {
      res.mutate(() => r);
      setF({ issuer: '', client_id: '', client_secret: '' });
    }
  };
  return (
    <Card title="1. Your identity provider" subtitle="Any OpenID Connect provider: Microsoft Entra ID, Google Workspace, Okta, OneLogin, JumpCloud">
      <dl className={dlClass}>
        <dt>Redirect URI</dt>
        <dd>
          <span className="mono small">{settings.redirect_uri}</span> <CopyButton text={settings.redirect_uri} />
        </dd>
        <dt>Scopes</dt>
        <dd className="mono small">openid email profile</dd>
      </dl>
      <p className="small secondary">
        Create a web application in your provider with this redirect URI, then copy its issuer, client ID and client secret here. Entra ID&apos;s
        issuer looks like <span className="mono">https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</span>, Google&apos;s is{' '}
        <span className="mono">https://accounts.google.com</span>, Okta&apos;s is your Okta domain.
      </p>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={formGridClass}>
          <TextField label="Issuer URL" type="url" required placeholder="https://" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} />
          <TextField label="Client ID" required value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })} />
          <TextField
            label="Client secret"
            type="password"
            autoComplete="off"
            required={!c}
            placeholder={c ? 'Stored — leave blank to keep it' : ''}
            value={f.client_secret}
            onChange={(e) => setF({ ...f, client_secret: e.target.value })}
          />
        </div>
        {c ? <p className="small secondary">Changing these puts single sign-on back to a draft until someone tests it again.</p> : null}
        <ActionError error={action.error} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          {c ? (
            <Button variant="quiet" onClick={remove} disabled={action.busy}>
              Remove connection
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" disabled={action.busy || !dirty || !f.issuer || !f.client_id || (!c && !f.client_secret)}>
            {action.busy ? 'Checking the provider…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Step 2: prove it works, then turn it on and choose who must use it. */
function TurnOn({ res, settings, tz }: { res: Res; settings: SsoSettings; tz: string }) {
  const c = settings.connection;
  const action = useAction();
  const hasVerified = settings.domains.some((d) => d.verified_at);
  const set = async (body: { active?: boolean; enforced?: boolean; jit_provisioning?: boolean }) => {
    const r = await action.run(() => rd.admin.setSsoOptions(body));
    if (r) res.mutate(() => r);
  };
  const test = async () => {
    const r = await action.run(() => rd.admin.testSso());
    if (r) window.location.assign(r.redirect_url);
  };
  if (!c) return null;
  const on = c.status === 'active';
  return (
    <Card
      title="2. Test and turn on"
      actions={<Badge tone={on ? 'solid' : 'outline'}>{on ? 'On' : 'Draft'}</Badge>}
    >
      <p className="small secondary">
        {c.tested_at
          ? `${c.tested_by_name ?? 'An admin'} signed in through it ${formatRelative(c.tested_at, tz)} (${formatDateTime(c.tested_at, tz)}).`
          : "Sign in through your provider as yourself once. Nobody else is affected until it's on."}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={test} disabled={action.busy}>
          Test sign-in →
        </Button>
        {on ? (
          <Button variant="quiet" onClick={() => set({ active: false })} disabled={action.busy}>
            Turn off
          </Button>
        ) : (
          <Button variant="primary" onClick={() => set({ active: true })} disabled={action.busy || !c.tested_at}>
            Turn on
          </Button>
        )}
      </div>
      {on ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Checkbox
            label="Require single sign-on"
            hint="Passwords stop working for everyone except org admins, who keep password + authenticator code as a way back in if the provider breaks."
            checked={c.enforced}
            disabled={action.busy}
            onChange={(e) => set({ enforced: e.target.checked })}
          />
          <Checkbox
            label="Create accounts on first sign-in"
            hint={
              hasVerified
                ? 'Anyone at a verified domain who can sign in to your provider joins as an employee, with tracking off until an admin turns it on.'
                : 'Verify one of your email domains below first.'
            }
            checked={c.jit_provisioning}
            disabled={action.busy || (!hasVerified && !c.jit_provisioning)}
            onChange={(e) => set({ jit_provisioning: e.target.checked })}
          />
        </div>
      ) : null}
      <ActionError error={action.error} />
    </Card>
  );
}

function Domains({ res, settings }: { res: Res; settings: SsoSettings }) {
  const [domain, setDomain] = useState('');
  const action = useAction();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const d = await action.run(() => rd.admin.addSsoDomain(domain.trim()));
    if (d) {
      res.mutate((prev) => prev && { ...prev, domains: [...prev.domains.filter((x) => x.id !== d.id), d].sort((a, b) => a.domain.localeCompare(b.domain)) });
      setDomain('');
    }
  };
  const verify = async (id: string) => {
    const d = await action.run(() => rd.admin.verifySsoDomain(id));
    if (d) res.mutate((prev) => prev && { ...prev, domains: prev.domains.map((x) => (x.id === id ? d : x)) });
  };
  const remove = async (id: string) => {
    if (await action.run(() => rd.admin.removeSsoDomain(id))) res.reload();
  };
  return (
    <Card title="Email domains" subtitle="Prove you own a domain with a DNS record. Only one organization can verify a domain.">
      {settings.domains.length === 0 ? (
        <Empty title="No domains yet">Add the domain in your people&apos;s work email addresses, like example.com.</Empty>
      ) : (
        <TableBox label="Email domains">
          <table className={tableClass} style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">State</th>
                <th scope="col">TXT record</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings.domains.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.domain}</th>
                  <td>{d.verified_at ? <Badge tone="solid">Verified</Badge> : <Badge>Waiting for DNS</Badge>}</td>
                  <td className="small">
                    {d.verified_at ? (
                      '—'
                    ) : (
                      <>
                        <div>
                          Name <span className="mono">{d.txt_name}</span>
                        </div>
                        <div>
                          Value <span className="mono">{d.txt_value}</span> <CopyButton text={d.txt_value} />
                        </div>
                      </>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: 8 }}>
                      {d.verified_at ? null : (
                        <Button size="sm" variant="primary" onClick={() => verify(d.id)} disabled={action.busy}>
                          Verify
                        </Button>
                      )}
                      <Button size="sm" variant="quiet" onClick={() => remove(d.id)} disabled={action.busy}>
                        Remove
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
      <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <TextField label="Add a domain" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <Button type="submit" disabled={action.busy || !domain.trim()}>
          Add
        </Button>
      </form>
      <ActionError error={action.error} />
    </Card>
  );
}

function Directory({ res, settings, tz }: { res: Res; settings: SsoSettings; tz: string }) {
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(ScimTokenDTO & { token: string }) | null>(null);
  const action = useAction();
  const close = () => {
    setCreating(false);
    setCreated(null);
    setLabel('');
    action.reset();
  };
  const create = async () => {
    const t = await action.run(() => rd.admin.createScimToken(label.trim()));
    if (t) {
      setCreated(t);
      const dto: ScimTokenDTO = { id: t.id, label: t.label, created_at: t.created_at, created_by_name: t.created_by_name, last_used_at: t.last_used_at };
      res.mutate((prev) => prev && { ...prev, scim: { ...prev.scim, tokens: [dto, ...prev.scim.tokens] } });
    }
  };
  const revoke = async (id: string) => {
    if (await action.run(() => rd.admin.revokeScimToken(id))) res.mutate((prev) => prev && { ...prev, scim: { ...prev.scim, tokens: prev.scim.tokens.filter((t) => t.id !== id) } });
  };
  return (
    <Card
      title="Directory sync (SCIM)"
      subtitle="Your provider adds, renames and deactivates people, and keeps teams in step with its groups"
      actions={
        <Button onClick={() => setCreating(true)} variant="primary">
          New token →
        </Button>
      }
    >
      <dl className={dlClass}>
        <dt>SCIM base URL</dt>
        <dd>
          <span className="mono small">{settings.scim.base_url}</span> <CopyButton text={settings.scim.base_url} />
        </dd>
        <dt>Authentication</dt>
        <dd>Bearer token (create one here)</dd>
      </dl>
      <p className="small secondary">
        People from your directory join as employees, tracked while a seat is free. Removing someone in the directory deactivates them in Track — their
        hours, timesheets and pay records stay. Groups become teams; a team&apos;s managers are still chosen in Track.
      </p>
      {settings.scim.tokens.length === 0 ? (
        <Empty title="No tokens">Create one and paste it into your provider&apos;s provisioning settings.</Empty>
      ) : (
        <TableBox label="Directory tokens">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings.scim.tokens.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.label}</th>
                  <td className="small">
                    {formatDateTime(t.created_at, tz)}
                    {t.created_by_name ? ` · ${t.created_by_name}` : ''}
                  </td>
                  <td className="small">{t.last_used_at ? formatRelative(t.last_used_at, tz) : 'Never'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="sm" variant="quiet" onClick={() => revoke(t.id)} disabled={action.busy}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
      <Dialog
        open={creating}
        onClose={close}
        size="sm"
        title={created ? 'Copy the token now' : 'New directory token'}
        description={created ? "It won't be shown again. Paste it into your provider as the secret token." : undefined}
        footer={
          created ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" onClick={create} disabled={action.busy || !label.trim()}>
                {action.busy ? 'Creating…' : 'Create token'}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="mono small" style={{ wordBreak: 'break-all' }}>
              {created.token}
            </span>
            <div>
              <CopyButton text={created.token} variant="secondary" />
            </div>
          </div>
        ) : (
          <TextField label="Name" placeholder="Entra ID provisioning" value={label} onChange={(e) => setLabel(e.target.value)} />
        )}
        <ActionError error={action.error} />
      </Dialog>
    </Card>
  );
}

function TestResult() {
  const params = useSearchParams();
  const ok = params.get('test') === 'ok';
  const err = params.get('test_error') as SsoErrorCode | null;
  if (ok) return <Banner role="status" title="Test sign-in worked">You can turn single sign-on on now.</Banner>;
  if (err && SSO_ERRORS[err])
    return (
      <Banner tone="warn" role="alert" title="Test sign-in didn't work">
        {SSO_ERRORS[err]}
      </Banner>
    );
  return null;
}

/** G26: sign in through the organization's identity provider, and let its directory manage people. */
export default function SsoPage() {
  const { access, timezone: tz } = useMe();
  const allowed = access.isAdmin && access.entitlements.includes('sso');
  const settings = useApi(allowed ? 'admin:sso' : null, (signal) => rd.admin.sso(signal));
  if (!access.isAdmin) return <NoAccess what="Single sign-on is managed by org admins." />;
  if (!allowed)
    return (
      <>
        <PageHeader eyebrow="Settings · Security" title="Single sign-on" />
        <Banner title="Single sign-on and directory sync are part of Pro" actions={<Link href="/admin/billing">Compare plans →</Link>}>
          Sign in through Microsoft Entra ID, Google Workspace or Okta, and let your directory add and remove people.
        </Banner>
      </>
    );
  return (
    <>
      <PageHeader
        eyebrow="Settings · Security"
        title="Single sign-on"
        description="People sign in through your identity provider, and your directory keeps Track's people and teams up to date."
      />
      <Suspense>
        <TestResult />
      </Suspense>
      <Resource {...settings} label="Loading single sign-on">
        {(s) => (
          <>
            <Provider key={`${s.connection?.issuer}|${s.connection?.client_id}`} res={settings} settings={s} />
            <TurnOn res={settings} settings={s} tz={tz} />
            <Domains res={settings} settings={s} />
            <Directory res={settings} settings={s} tz={tz} />
          </>
        )}
      </Resource>
    </>
  );
}
