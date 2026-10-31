'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { SSO_ERRORS, type ScimTokenDTO, type SsoConnectionRequest, type SsoErrorCode, type SsoProtocol, type SsoSettings } from '@rd/contracts';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Segmented, TextArea, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, dlClass, formGridClass, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { ssoErrorText, t } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { certificateWarning, samlManualReady } from '@/lib/sso';
import { formatDateTime, formatRelative } from '@/lib/time';
import { useAction, useApi, type ApiResource } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

type Res = ApiResource<SsoSettings>;

/** Step 1: the provider, and what to paste into it. Either protocol; switching replaces the other's details. */
function Provider({ res, settings, tz }: { res: Res; settings: SsoSettings; tz: string }) {
  const c = settings.connection;
  const [protocol, setProtocol] = useState<SsoProtocol>(c?.protocol ?? 'oidc');
  const action = useAction();
  const save = async (body: SsoConnectionRequest) => {
    const r = await action.run(() => rd.admin.saveSsoConnection(body));
    if (r) res.mutate(() => r);
    return Boolean(r);
  };
  const remove = async () => {
    const r = await action.run(() => rd.admin.deleteSsoConnection());
    if (r) res.mutate(() => r);
  };
  const switching = c && c.protocol !== protocol;
  return (
    <Card
      title={t('cfg.sso.providerTitle')}
      subtitle={t('cfg.sso.providerSubtitle')}
    >
      <Segmented<SsoProtocol>
        legend={t('cfg.sso.protocol')}
        name="sso-protocol"
        value={protocol}
        onChange={(p) => {
          setProtocol(p);
          action.reset();
        }}
        options={[
          { value: 'oidc', label: 'OpenID Connect' },
          { value: 'saml', label: 'SAML 2.0' },
        ]}
      />
      {switching ? (
        <p className="small secondary">{t('cfg.sso.switching', { protocol: c.protocol === 'oidc' ? 'OpenID Connect' : 'SAML' })}</p>
      ) : null}
      {protocol === 'oidc' ? (
        <OidcProvider key={`${c?.issuer}|${c?.client_id}`} settings={settings} busy={action.busy} save={save} />
      ) : (
        <SamlProvider key={`${c?.saml?.entity_id}|${c?.saml?.sso_url}`} settings={settings} tz={tz} busy={action.busy} save={save} />
      )}
      <ActionError error={action.error} />
      {c ? (
        <div>
          <Button variant="quiet" onClick={remove} disabled={action.busy}>
            {t('cfg.sso.removeConnection')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

type SaveFn = (body: SsoConnectionRequest) => Promise<boolean>;

function OidcProvider({ settings, busy, save }: { settings: SsoSettings; busy: boolean; save: SaveFn }) {
  const c = settings.connection?.protocol === 'oidc' ? settings.connection : null;
  const [f, setF] = useState({ issuer: c?.issuer ?? '', client_id: c?.client_id ?? '', client_secret: '' });
  const dirty = !c || f.issuer !== c.issuer || f.client_id !== c.client_id || f.client_secret !== '';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await save({ protocol: 'oidc', issuer: f.issuer.trim(), client_id: f.client_id.trim(), ...(f.client_secret ? { client_secret: f.client_secret } : {}) });
    if (ok) setF((x) => ({ ...x, client_secret: '' }));
  };
  return (
    <>
      <dl className={dlClass}>
        <dt>{t('cfg.sso.redirectUri')}</dt>
        <dd>
          <span className="mono small">{settings.redirect_uri}</span> <CopyButton text={settings.redirect_uri} />
        </dd>
        <dt>{t('cfg.sso.scopes')}</dt>
        <dd className="mono small">openid email profile</dd>
      </dl>
      <p className="small secondary">
        {t('cfg.sso.oidcHelpA')} <span className="mono">https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</span>
        {t('cfg.sso.oidcHelpB')} <span className="mono">https://accounts.google.com</span>
        {t('cfg.sso.oidcHelpC')}
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={formGridClass}>
          <TextField label={t('cfg.sso.issuer')} type="url" required placeholder="https://" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} />
          <TextField label={t('cfg.sso.clientId')} required value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })} />
          <TextField
            label={t('cfg.sso.clientSecret')}
            type="password"
            autoComplete="off"
            required={!c}
            placeholder={c ? t('cfg.sso.secretStored') : ''}
            value={f.client_secret}
            onChange={(e) => setF({ ...f, client_secret: e.target.value })}
          />
        </div>
        {c ? <p className="small secondary">{t('cfg.sso.oidcDraftNote')}</p> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" disabled={busy || !dirty || !f.issuer || !f.client_id || (!c && !f.client_secret)}>
            {busy ? t('cfg.sso.checking') : t('common.save')}
          </Button>
        </div>
      </form>
    </>
  );
}

function SamlProvider({ settings, tz, busy, save }: { settings: SsoSettings; tz: string; busy: boolean; save: SaveFn }) {
  const c = settings.connection?.protocol === 'saml' ? settings.connection : null;
  const [mode, setMode] = useState<'metadata' | 'manual'>('metadata');
  const [xml, setXml] = useState('');
  const [f, setF] = useState({ idp_entity_id: c?.saml?.entity_id ?? '', sso_url: c?.saml?.sso_url ?? '', certificate: '' });
  const sp = settings.saml;
  const warning = certificateWarning(c?.saml ?? null, new Date());
  const ready = mode === 'metadata' ? Boolean(xml.trim()) : samlManualReady(f);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await save(
      mode === 'metadata'
        ? { protocol: 'saml', metadata_xml: xml.trim() }
        : { protocol: 'saml', idp_entity_id: f.idp_entity_id.trim(), sso_url: f.sso_url.trim(), certificate: f.certificate.trim() },
    );
    if (ok) {
      setXml('');
      setF((x) => ({ ...x, certificate: '' }));
    }
  };
  return (
    <>
      <dl className={dlClass}>
        <dt>{t('cfg.sso.entityId')}</dt>
        <dd>
          <span className="mono small">{sp.entity_id}</span> <CopyButton text={sp.entity_id} />
        </dd>
        <dt>{t('cfg.sso.acs')}</dt>
        <dd>
          <span className="mono small">{sp.acs_url}</span> <CopyButton text={sp.acs_url} />
        </dd>
        <dt>{t('cfg.sso.metadata')}</dt>
        <dd>
          <a className="mono small" href={sp.metadata_url} target="_blank" rel="noreferrer">
            {sp.metadata_url}
          </a>
        </dd>
        <dt>{t('cfg.sso.nameId')}</dt>
        <dd className="small">
          {t('cfg.sso.nameIdA')} <span className="mono">email</span> {t('cfg.sso.nameIdB')}
        </dd>
      </dl>
      <p className="small secondary">
        {t('cfg.sso.samlHelp')}
      </p>
      {c?.saml ? (
        <dl className={dlClass}>
          <dt>{t('cfg.sso.provider')}</dt>
          <dd className="mono small">{c.saml.entity_id}</dd>
          <dt>{t('cfg.sso.signInUrl')}</dt>
          <dd className="mono small" style={{ wordBreak: 'break-all' }}>
            {c.saml.sso_url}
          </dd>
          <dt>{c.saml.certificates.length > 1 ? t('cfg.sso.certificates') : t('cfg.sso.certificate')}</dt>
          <dd className="small">
            {c.saml.certificates.map((x) => (
              <div key={`${x.subject}|${x.expires_at}`}>
                {t('cfg.sso.certExpires', { subject: x.subject, when: formatDateTime(x.expires_at, tz) })}
              </div>
            ))}
          </dd>
        </dl>
      ) : null}
      {warning ? (
        <Banner tone="warn" title={warning.expired ? t('cfg.sso.certExpired') : t('cfg.sso.certSoon')}>
          {t('cfg.sso.certBody')}
        </Banner>
      ) : null}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Segmented<'metadata' | 'manual'>
          legend={t('cfg.sso.howToAdd')}
          name="saml-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'metadata', label: t('cfg.sso.pasteMetadata') },
            { value: 'manual', label: t('cfg.sso.byHand') },
          ]}
        />
        {mode === 'metadata' ? (
          <TextArea
            label={t('cfg.sso.metadataXml')}
            hint={t('cfg.sso.metadataHint')}
            rows={6}
            spellCheck={false}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
            placeholder='<EntityDescriptor entityID="…">'
            value={xml}
            onChange={(e) => setXml(e.target.value)}
          />
        ) : (
          <div className={formGridClass}>
            <TextField label={t('cfg.sso.idpEntityId')} required value={f.idp_entity_id} onChange={(e) => setF({ ...f, idp_entity_id: e.target.value })} />
            <TextField label={t('cfg.sso.ssoUrl')} type="url" required placeholder="https://" value={f.sso_url} onChange={(e) => setF({ ...f, sso_url: e.target.value })} />
            <TextArea
              label={t('cfg.sso.signingCert')}
              hint={t('cfg.sso.signingCertHint')}
              rows={4}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
              placeholder="-----BEGIN CERTIFICATE-----"
              value={f.certificate}
              onChange={(e) => setF({ ...f, certificate: e.target.value })}
            />
          </div>
        )}
        {c ? <p className="small secondary">{t('cfg.sso.samlDraftNote')}</p> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </>
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
      title={t('cfg.sso.turnOnTitle')}
      actions={<Badge tone={on ? 'solid' : 'outline'}>{on ? t('cfg.sso.on') : t('cfg.sso.draft')}</Badge>}
    >
      <p className="small secondary">
        {c.tested_at
          ? t('cfg.sso.tested', { name: c.tested_by_name ?? t('cfg.sso.anAdmin'), rel: formatRelative(c.tested_at, tz), when: formatDateTime(c.tested_at, tz) })
          : t('cfg.sso.testPrompt')}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={test} disabled={action.busy}>
          {t('cfg.sso.test')}
        </Button>
        {on ? (
          <Button variant="quiet" onClick={() => set({ active: false })} disabled={action.busy}>
            {t('cfg.sso.turnOff')}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => set({ active: true })} disabled={action.busy || !c.tested_at}>
            {t('cfg.sso.turnOn')}
          </Button>
        )}
      </div>
      {on ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Checkbox
            label={t('cfg.sso.require')}
            hint={t('cfg.sso.requireHint')}
            checked={c.enforced}
            disabled={action.busy}
            onChange={(e) => set({ enforced: e.target.checked })}
          />
          <Checkbox
            label={t('cfg.sso.jit')}
            hint={hasVerified ? t('cfg.sso.jitHint') : t('cfg.sso.jitNeedsDomain')}
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
    <Card title={t('cfg.sso.domainsTitle')} subtitle={t('cfg.sso.domainsSubtitle')}>
      {settings.domains.length === 0 ? (
        <Empty title={t('cfg.sso.noDomains')}>{t('cfg.sso.noDomainsBody')}</Empty>
      ) : (
        <TableBox label={t('cfg.sso.domainsTitle')}>
          <table className={tableClass} style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th scope="col">{t('cfg.sso.colDomain')}</th>
                <th scope="col">{t('cfg.sso.colState')}</th>
                <th scope="col">{t('cfg.sso.colTxt')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('cfg.tok.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings.domains.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.domain}</th>
                  <td>{d.verified_at ? <Badge tone="solid">{t('cfg.sso.verified')}</Badge> : <Badge>{t('cfg.sso.waitingDns')}</Badge>}</td>
                  <td className="small">
                    {d.verified_at ? (
                      '—'
                    ) : (
                      <>
                        <div>
                          {t('cfg.sso.txtName')} <span className="mono">{d.txt_name}</span>
                        </div>
                        <div>
                          {t('cfg.sso.txtValue')} <span className="mono">{d.txt_value}</span> <CopyButton text={d.txt_value} />
                        </div>
                      </>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: 8 }}>
                      {d.verified_at ? null : (
                        <Button size="sm" variant="primary" onClick={() => verify(d.id)} disabled={action.busy}>
                          {t('cfg.sso.verify')}
                        </Button>
                      )}
                      <Button size="sm" variant="quiet" onClick={() => remove(d.id)} disabled={action.busy}>
                        {t('cfg.brand.remove')}
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
        <TextField label={t('cfg.sso.addDomain')} placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <Button type="submit" disabled={action.busy || !domain.trim()}>
          {t('cfg.sso.add')}
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
    const tok = await action.run(() => rd.admin.createScimToken(label.trim()));
    if (tok) {
      setCreated(tok);
      const dto: ScimTokenDTO = { id: tok.id, label: tok.label, created_at: tok.created_at, created_by_name: tok.created_by_name, last_used_at: tok.last_used_at };
      res.mutate((prev) => prev && { ...prev, scim: { ...prev.scim, tokens: [dto, ...prev.scim.tokens] } });
    }
  };
  const revoke = async (id: string) => {
    if (await action.run(() => rd.admin.revokeScimToken(id))) res.mutate((prev) => prev && { ...prev, scim: { ...prev.scim, tokens: prev.scim.tokens.filter((x) => x.id !== id) } });
  };
  return (
    <Card
      title={t('cfg.sso.scimTitle')}
      subtitle={t('cfg.sso.scimSubtitle')}
      actions={
        <Button onClick={() => setCreating(true)} variant="primary">
          {t('cfg.tok.new')}
        </Button>
      }
    >
      <dl className={dlClass}>
        <dt>{t('cfg.sso.scimBase')}</dt>
        <dd>
          <span className="mono small">{settings.scim.base_url}</span> <CopyButton text={settings.scim.base_url} />
        </dd>
        <dt>{t('cfg.sso.auth')}</dt>
        <dd>{t('cfg.sso.bearer')}</dd>
      </dl>
      <p className="small secondary">
        {t('cfg.sso.scimHelp')}
      </p>
      {settings.scim.tokens.length === 0 ? (
        <Empty title={t('cfg.sso.noTokens')}>{t('cfg.sso.noTokensBody')}</Empty>
      ) : (
        <TableBox label={t('cfg.sso.tokensLabel')}>
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col">{t('cfg.tok.name')}</th>
                <th scope="col">{t('cfg.hook.colCreated')}</th>
                <th scope="col">{t('cfg.tok.colLastUsed')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('cfg.tok.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings.scim.tokens.map((tok) => (
                <tr key={tok.id}>
                  <th scope="row">{tok.label}</th>
                  <td className="small">
                    {formatDateTime(tok.created_at, tz)}
                    {tok.created_by_name ? ` · ${tok.created_by_name}` : ''}
                  </td>
                  <td className="small">{tok.last_used_at ? formatRelative(tok.last_used_at, tz) : t('time.never')}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="sm" variant="quiet" onClick={() => revoke(tok.id)} disabled={action.busy}>
                      {t('cfg.tok.revoke')}
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
        title={created ? t('cfg.sso.copyNow') : t('cfg.sso.newToken')}
        description={created ? t('cfg.sso.copyNowBody') : undefined}
        footer={
          created ? (
            <Button variant="primary" onClick={close}>
              {t('cfg.hook.done')}
            </Button>
          ) : (
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={create} disabled={action.busy || !label.trim()}>
                {action.busy ? t('cfg.tok.creating') : t('cfg.tok.create')}
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
          <TextField label={t('cfg.tok.name')} placeholder={t('cfg.sso.tokenPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
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
  if (ok) return <Banner role="status" title={t('cfg.sso.testOk')}>
        {t('cfg.sso.testOkBody')}
      </Banner>;
  if (err && SSO_ERRORS[err])
    return (
      <Banner tone="warn" role="alert" title={t('cfg.sso.testFailed')}>
        {ssoErrorText(t, err)}
      </Banner>
    );
  return null;
}

/** G26: sign in through the organization's identity provider, and let its directory manage people. */
export default function SsoPage() {
  const { access, timezone: tz } = useMe();
  const allowed = access.isAdmin && access.entitlements.includes('sso');
  const settings = useApi(allowed ? 'admin:sso' : null, (signal) => rd.admin.sso(signal));
  if (!access.isAdmin) return <NoAccess what={t('cfg.sso.noAccess')} />;
  if (!allowed)
    return (
      <>
        <PageHeader eyebrow={t('cfg.eyebrow.security')} title={t('nav.sso')} />
        <Banner title={t('cfg.sso.proTitle')} actions={<Link href="/admin/billing">{t('cfg.dev.comparePlans')}</Link>}>
          {t('cfg.sso.proBody')}
        </Banner>
      </>
    );
  return (
    <>
      <PageHeader
        eyebrow={t('cfg.eyebrow.security')}
        title={t('nav.sso')}
        description={t('cfg.sso.description')}
      />
      <Suspense>
        <TestResult />
      </Suspense>
      <Resource {...settings} label={t('cfg.sso.loading')}>
        {(s) => (
          <>
            <Provider key={s.connection?.protocol ?? 'none'} res={settings} settings={s} tz={tz} />
            <TurnOn res={settings} settings={s} tz={tz} />
            <Domains res={settings} settings={s} />
            <Directory res={settings} settings={s} tz={tz} />
          </>
        )}
      </Resource>
    </>
  );
}
