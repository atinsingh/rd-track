'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { LinkRequestView } from '@rd/contracts';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { Banner, Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t, type MessageKey } from '@/lib/i18n';
import { formatCountdown } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import s from './connect.module.css';

const OS_LABEL = { macos: 'macOS', windows: 'Windows', linux: 'Linux' } as const;

/** Why a request can't be confirmed (anything but pending), in the person's words. */
const UNUSABLE: Record<Exclude<LinkRequestView['status'], 'pending'> | 'unknown', MessageKey> = {
  approved: 'connect.used',
  used: 'connect.used',
  expired: 'connect.expired',
  denied: 'connect.denied',
  unknown: 'connect.unknown',
};

function Unusable({ why }: { why: keyof typeof UNUSABLE }) {
  return (
    <Banner tone="warn" title={t('connect.unusable')} role="alert" actions={<ButtonLink href="/me/computers">{t('connect.toComputers')}</ButtonLink>}>
      {t(UNUSABLE[why])}
    </Banner>
  );
}

function Countdown({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Date.parse(at) - now;
  return left > 0 ? <>{t('connect.expiresIn', { left: formatCountdown(left) })}</> : null;
}

function Laptop() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h16v10H4z" />
      <path d="M2 19h20" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className={s.draw} d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** The three steps of signing in to connect, as the desktop app shows them. */
function Steps({ at }: { at: 2 | 3 }) {
  return (
    <div className={s.steps} aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <span key={n} className={n < at ? s.stepDone : n === at ? s.stepOn : undefined} />
      ))}
    </div>
  );
}

function Device({ req }: { req: LinkRequestView }) {
  return (
    <div className={s.device}>
      <span className={s.deviceIcon}>
        <Laptop />
      </span>
      <span className={s.deviceText}>
        <strong>{req.device_name}</strong>
        <span className="small secondary">
          {OS_LABEL[req.os]} · {t('connect.requested')}
        </span>
      </span>
    </div>
  );
}

function Confirm({ req }: { req: LinkRequestView }) {
  const action = useAction();
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null);

  const act = async (fn: () => Promise<unknown>, done: 'approved' | 'denied') => {
    const r = await action.run(fn);
    if (r) setOutcome(done);
  };

  if (outcome === 'approved') {
    return (
      <Card className={s.card}>
        <Steps at={3} />
        <div className={s.done} role="status">
          <span className={s.mark}>
            <Check />
          </span>
          <h2 className={s.doneTitle}>{t('connect.doneTitle')}</h2>
          <p className="secondary">{t('connect.doneBody', { device: req.device_name })}</p>
          <p className="small muted">{t('connect.doneClose')}</p>
        </div>
      </Card>
    );
  }
  if (outcome === 'denied') {
    return (
      <Banner title={t('connect.cancelledTitle')} role="status">
        {t('connect.cancelledBody')}
      </Banner>
    );
  }
  // The request ran out (or was used elsewhere) while the page was open.
  if (action.error?.code === 'link_expired') return <Unusable why="expired" />;

  const [a = '', b = ''] = req.user_code.split('-');
  return (
    <Card className={s.card}>
      <Steps at={2} />
      <p className={s.eyebrow}>{t('connect.step')}</p>
      <Device req={req} />
      <div className={s.codeBlock}>
        <p className="secondary" style={{ margin: 0 }}>
          {t('connect.codeCheck')}
        </p>
        <p className={s.tiles} role="text" aria-label={`${t('connect.codeLabel')}: ${req.user_code.split('').join(' ')}`}>
          {[...a].map((c, i) => (
            <span key={`a${i}`} className={s.tile}>
              {c}
            </span>
          ))}
          <span className={s.dash}>–</span>
          {[...b].map((c, i) => (
            <span key={`b${i}`} className={s.tile}>
              {c}
            </span>
          ))}
        </p>
      </div>
      <Banner tone="warn" tag="NOTE">
        {t('connect.warning')}
      </Banner>
      <div className={s.actions}>
        <Button variant="primary" disabled={action.busy} onClick={() => act(() => rd.my.approveLink(req.request_id), 'approved')}>
          {action.busy ? t('connect.connecting') : t('connect.confirm')}
        </Button>
        <Button variant="quiet" disabled={action.busy} onClick={() => act(() => rd.my.denyLink(req.request_id), 'denied')}>
          {t('connect.cancel')}
        </Button>
        <span className={`small secondary ${s.left}`}>
          <Countdown at={req.expires_at} />
        </span>
      </div>
      <ActionError error={action.error} />
    </Card>
  );
}

/**
 * Signing in to connect: the desktop app opens this page (after sign-in, however the
 * organization signs in) so the person can check the code and confirm the computer is theirs.
 */
export default function ConnectPage() {
  const id = useSearchParams().get('request') ?? '';
  const res = useApi(id ? `link:${id}` : null, (signal) => rd.my.linkRequest(id, signal));

  let body;
  if (!id || res.error?.code === 'not_found') body = <Unusable why="unknown" />;
  else if (res.error) body = <ErrorState error={res.error} onRetry={res.reload} />;
  else if (!res.data) body = <Loading label={t('connect.loading')} />;
  else if (res.data.status !== 'pending') body = <Unusable why={res.data.status} />;
  else body = <Confirm req={res.data} />;

  return (
    <>
      <PageHeader eyebrow={t('connect.eyebrow')} title={t('connect.title')} description={t('connect.description')} />
      {body}
    </>
  );
}
