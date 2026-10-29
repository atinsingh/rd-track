'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useSyncExternalStore } from 'react';
import { API_TOKEN_MAX_DAYS } from '@rd/contracts';
import { ApiTokens } from '@/components/developers/ApiTokens';
import { WebhooksPanel } from '@/components/developers/WebhooksPanel';
import s from '@/components/developers/developers.module.css';
import { Banner, Card, PageHeader, dlClass } from '@/components/ui/Layout';
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
    <Card title="Quick start" className={s.aside}>
      <pre className={s.code}>{`curl ${origin}/v1/admin/users \\
  -H "Authorization: Bearer $RD_TOKEN"`}</pre>
      <dl className={dlClass}>
        <dt>Organization</dt>
        <dd>Admins only. Read, or read and write, up to 1 year. Acts as the admin who made it.</dd>
        <dt>Personal</dt>
        <dd>Anyone, from My account. Read only, your own data, up to {API_TOKEN_MAX_DAYS.personal} days.</dd>
        <dt>Never exposed</dt>
        <dd>Screenshot images; pay rates and payroll files without the payroll scope.</dd>
      </dl>
      <p className="small secondary">
        Every call is in the <Link href="/audit">audit log</Link> under the token&apos;s name.
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
  const go = (t: Tab) => router.replace(t === 'tokens' ? path : `${path}?tab=${t}`);
  return (
    <>
      <PageHeader
        eyebrow="Settings · Pro"
        title="Developers"
        description="Connect payroll, HR and BI tools to the REST API. Tokens see what their creator could see — never more — and every call is in the audit log under the token's name."
      />
      <div role="tablist" aria-label="Developer settings" className={s.tabs}>
        <button type="button" role="tab" aria-selected={tab === 'tokens'} className={s.tab} onClick={() => go('tokens')}>
          API tokens
        </button>
        {hooks ? (
          <button type="button" role="tab" aria-selected={tab === 'webhooks'} className={s.tab} onClick={() => go('webhooks')}>
            Webhooks
          </button>
        ) : null}
        <a href="/v1/docs" target="_blank" rel="noreferrer" className={s.tab}>
          API reference ↗
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
        <Banner title="The API is part of Pro" actions={<Link href="/admin/billing">Compare plans →</Link>}>
          Read and write people, time, timesheets and payroll from your own tools.
        </Banner>
      )}
    </>
  );
}

/** Settings › Developers (F5): API tokens, webhooks and the API reference. */
export default function DevelopersPage() {
  const { access } = useMe();
  if (!access.isAdmin) return <NoAccess what="Developer settings are managed by org admins. Personal API tokens are in My account › Settings." />;
  return (
    <Suspense>
      <Developers />
    </Suspense>
  );
}
