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
import { t } from '@/lib/i18n';
import { currentLocale } from '@/lib/locale';
import { useMe } from '@/lib/me';
import { formatRelative } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from './developers.module.css';

const DAY = 24 * 3600_000;
const LIFETIMES: Record<ApiTokenKind, number[]> = { organization: [30, 90, 180, 365], personal: [30, 60, 90] };
const lifetime = (d: number) => (d === 365 ? t('cfg.tok.year') : t('cfg.tok.days', { n: d }));

function expiry(tok: ApiTokenDTO, tz: string, now: number): { text: string; soon: boolean } {
  const left = Date.parse(tok.expires_at) - now;
  if (tok.expired || left <= 0) return { text: t('cfg.tok.expired'), soon: true };
  if (left < 14 * DAY) return { text: t('cfg.tok.inDays', { n: Math.max(1, Math.ceil(left / DAY)) }), soon: true };
  const day = new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
  return { text: day.format(new Date(tok.expires_at)), soon: false };
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
    const created = await action.run(() => rd.apiTokens.create({ name: name.trim(), kind, scopes, expires_in_days: Math.min(days, API_TOKEN_MAX_DAYS[kind]) }));
    if (created) {
      onCreated(created);
      close();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('cfg.tok.newTitle')}
      eyebrow={t('cfg.tok.newEyebrow')}
      description={kind === 'organization' ? t('cfg.tok.orgDescription') : t('cfg.tok.personalDescription')}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={create} disabled={action.busy || !name.trim()}>
            {action.busy ? t('cfg.tok.creating') : t('cfg.tok.create')}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <TextField
          label={t('cfg.tok.name')}
          placeholder={kind === 'organization' ? t('cfg.tok.placeholderOrg') : t('cfg.tok.placeholderPersonal')}
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {admin ? (
          <Segmented<ApiTokenKind>
            legend={t('cfg.tok.kind')}
            name="token-kind"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setDays((d) => Math.min(d, API_TOKEN_MAX_DAYS[k]));
            }}
            options={[
              { value: 'organization', label: t('cfg.tok.organization') },
              { value: 'personal', label: t('cfg.tok.personal') },
            ]}
          />
        ) : null}
        {kind === 'organization' ? (
          <>
            <Segmented<'read' | 'write'>
              legend={t('cfg.tok.access')}
              name="token-access"
              value={write}
              onChange={setWrite}
              options={[
                { value: 'read', label: t('cfg.tok.read') },
                { value: 'write', label: t('cfg.tok.readWrite') },
              ]}
            />
            <Checkbox label={t('cfg.tok.payroll')} hint={t('cfg.tok.payrollHint')} checked={payroll} onChange={(e) => setPayroll(e.target.checked)} />
          </>
        ) : null}
        <SelectField label={t('cfg.tok.expiresAfter')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
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
        <h2 className={s.revealTitle}>{t('cfg.tok.ready', { name: token.name })}</h2>
        <span className="small">{t('cfg.tok.onceOnly')}</span>
      </div>
      <div className={s.revealRow}>
        <code className={s.secret}>{token.token}</code>
        <CopyButton text={token.token} label={t('cfg.tok.copy')} variant="inverse" />
        <Button variant="quiet" className={s.onInk} onClick={onDone}>
          {t('cfg.tok.stored')}
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
      tokens.mutate((prev) => prev?.filter((tok) => tok.id !== revoking.id));
      setRevoking(null);
    }
  };
  return (
    <>
      {created ? <Reveal token={created} onDone={() => setCreated(null)} /> : null}
      <Card
        title={mode === 'admin' ? t('cfg.tok.tokens') : t('cfg.tok.apiTokens')}
        subtitle={mode === 'personal' ? t('cfg.tok.personalSubtitle') : undefined}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('cfg.tok.new')}
          </Button>
        }
      >
        <Resource {...tokens} label={t('cfg.tok.loading')}>
          {(all) => {
            const list = mode === 'admin' ? all : all.filter((tok) => tok.kind === 'personal' && tok.owner_id === me.user.id);
            return list.length === 0 ? (
              <Empty title={t('cfg.tok.none')}>{mode === 'admin' ? t('cfg.tok.noneAdmin') : t('cfg.tok.nonePersonal')}</Empty>
            ) : (
              <TableBox label={t('cfg.tok.apiTokens')}>
                <table className={tableClass} style={{ minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('cfg.tok.name')}</th>
                      <th scope="col">{t('cfg.tok.colAccess')}</th>
                      <th scope="col">{t('cfg.tok.colLastUsed')}</th>
                      <th scope="col">{t('cfg.tok.colExpires')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('cfg.tok.colActions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((tok) => {
                      const ex = expiry(tok, tz, now);
                      return (
                        <tr key={tok.id}>
                          <th scope="row">
                            <span className={s.name}>{tok.name}</span>
                            <span className="small muted">
                              {tok.kind === 'organization' ? t('cfg.tok.orgBy', { name: tok.owner_name }) : t('cfg.tok.personalBy', { name: tok.owner_name })}
                            </span>
                          </th>
                          <td>
                            <span className={s.chips}>
                              {tok.kind === 'personal' ? <Badge>{t('cfg.tok.readOwn')}</Badge> : tok.scopes.map((sc) => <Badge key={sc}>{t(`cfg.tok.scope.${sc}`)}</Badge>)}
                            </span>
                          </td>
                          <td className="small">{tok.last_used_at ? formatRelative(tok.last_used_at, tz) : t('time.never')}</td>
                          <td className={ex.soon ? `small ${s.soon}` : 'small'}>{ex.text}</td>
                          <td style={{ textAlign: 'right' }}>
                            <Button size="sm" variant="quiet" aria-label={t('cfg.tok.revokeLabel', { name: tok.name })} onClick={() => setRevoking(tok)}>
                              {t('cfg.tok.revoke')}
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
        onCreated={(c) => {
          setCreated(c);
          const { token: _secret, ...dto } = c;
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
        title={t('cfg.tok.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('cfg.tok.revokeBody')}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={revoke} disabled={action.busy}>
              {action.busy ? t('cfg.tok.revoking') : t('cfg.tok.revokeConfirm')}
            </Button>
          </>
        }
      >
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}
