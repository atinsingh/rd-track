'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useSyncExternalStore } from 'react';
import { API_TOKEN_MAX_DAYS } from '@rd/contracts';
import { ApiTokens } from '@/components/developers/ApiTokens';
import { WebhooksPanel } from '@/components/developers/WebhooksPanel';
import s from '@/components/developers/developers.module.css';
import { Banner, Card, PageHeader, dlClass } from '@/components/ui/Layout';
import { t } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { NoAccess } from '../../NoAccess';

type Tab = 'tokens' | 'webhooks';

function QuickStart() {
  // The address people reach Track on; the API is served from the same origin.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => 'https://[YOUR TRACK ADDRESS]',
  );
  return (
    <Card title={t('cfg.dev.quickStart')} className={s.aside}>
      <pre className={s.code}>{`curl ${origin}/v1/admin/users \\
  -H "Authorization: Bearer $RD_TOKEN"`}</pre>
      <dl className={dlClass}>
        <dt>{t('cfg.dev.organization')}</dt>
        <dd>{t('cfg.dev.organizationBody')}</dd>
        <dt>{t('cfg.dev.personal')}</dt>
        <dd>{t('cfg.dev.personalBody', { n: API_TOKEN_MAX_DAYS.personal })}</dd>
        <dt>{t('cfg.dev.never')}</dt>
        <dd>{t('cfg.dev.neverBody')}</dd>
      </dl>
      <p className="small secondary">
        {t('cfg.dev.everyCallBefore')} <Link href="/audit">{t('cfg.support.auditLog')}</Link> {t('cfg.dev.everyCallAfter')}
      </p>
    </Card>
  );
}

function Developers() {
  const { access } = useMe();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const api = access.entitlements.includes('api_access');
  const hooks = access.entitlements.includes('webhooks');
  const tab: Tab = params.get('tab') === 'webhooks' && hooks ? 'webhooks' : 'tokens';
  const go = (next: Tab) => router.replace(next === 'tokens' ? path : `${path}?tab=${next}`);
  return (
    <>
      <PageHeader
        eyebrow={t('cfg.dev.eyebrow')}
        title={t('cfg.dev.title')}
        description={t('cfg.dev.description')}
      />
      <div role="tablist" aria-label={t('cfg.dev.tabs')} className={s.tabs}>
        <button type="button" role="tab" aria-selected={tab === 'tokens'} className={s.tab} onClick={() => go('tokens')}>
          {t('cfg.dev.tabTokens')}
        </button>
        {hooks ? (
          <button type="button" role="tab" aria-selected={tab === 'webhooks'} className={s.tab} onClick={() => go('webhooks')}>
            {t('cfg.dev.tabWebhooks')}
          </button>
        ) : null}
        <a href="/v1/docs" target="_blank" rel="noreferrer" className={s.tab}>
          {t('cfg.dev.tabReference')}
        </a>
      </div>
      {tab === 'webhooks' ? (
        <WebhooksPanel />
      ) : api ? (
        <div className={s.split}>
          <div className={s.main}>
            <ApiTokens mode="admin" />
          </div>
          <QuickStart />
        </div>
      ) : (
        <Banner title={t('cfg.dev.proTitle')} actions={<Link href="/admin/billing">{t('cfg.dev.comparePlans')}</Link>}>
          {t('cfg.dev.proBody')}
        </Banner>
      )}
    </>
  );
}

/** Settings › Developers (F5): API tokens, webhooks and the API reference. */
export default function DevelopersPage() {
  const { access } = useMe();
  if (!access.isAdmin) return <NoAccess what={t('cfg.dev.noAccess')} />;
  return (
    <Suspense>
      <Developers />
    </Suspense>
  );
}
