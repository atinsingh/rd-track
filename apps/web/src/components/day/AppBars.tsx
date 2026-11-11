'use client';

import { useState } from 'react';
import type { AppUsageRow } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Layout';
import { Empty } from '@/components/ui/DataState';
import { formatDuration } from '@/lib/format';
import { t } from '@/lib/i18n';
import s from './day.module.css';

const TOP = 8;

export function AppBars({ apps }: { apps: readonly AppUsageRow[] }) {
  const [all, setAll] = useState(false);
  const sorted = [...apps].sort((a, b) => b.seconds - a.seconds);
  const max = sorted[0]?.seconds ?? 0;
  const shown = all ? sorted : sorted.slice(0, TOP);
  const hasDomains = sorted.some((a) => a.domain);
  return (
    <Card
      title={t('day.appsTitle')}
      subtitle={hasDomains ? t('apps.withDomains') : t('apps.namesOnly')}
      className="grow"
    >
      {sorted.length === 0 ? (
        <Empty title={t('apps.none')}>{t('apps.noneBody')}</Empty>
      ) : (
        <>
          <ul className={s.apps}>
            {shown.map((a) => (
              <li key={`${a.app_identifier}|${a.domain ?? ''}`} className={s.appRow}>
                <span className={s.appName} title={a.app_name}>
                  {a.app_name}
                  {a.domain ? <span className={s.appDomain}>{a.domain}</span> : null}
                </span>
                <span className={s.track} aria-hidden="true">
                  <span className={s.fill} style={{ width: `${max > 0 ? (a.seconds / max) * 100 : 0}%` }} />
                </span>
                <span className={s.appDur}>{formatDuration(a.seconds)}</span>
              </li>
            ))}
          </ul>
          {sorted.length > TOP ? (
            <Button variant="link" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? t('apps.showTop') : t('apps.showAll', { n: sorted.length })}
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}
