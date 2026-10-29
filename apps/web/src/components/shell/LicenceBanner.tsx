'use client';

import Link from 'next/link';
import { Banner } from '@/components/ui/Layout';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/me';

/** Licence state from GET /v1/me (commercial model §4). Billing never hides collection. */
export function LicenceBanner() {
  const { me, access } = useMe();
  const t = useT();
  const license = me.organization.license;
  if (license === 'active') return null;
  if (license === 'grace') {
    return (
      <Banner
        tone="warn"
        role="status"
        title={t('licence.graceTitle')}
        actions={access.isAdmin ? <Link href="/admin/billing">{t('licence.openBilling')}</Link> : undefined}
      >
        {t('licence.keepsWorking')} {access.isAdmin ? t('licence.adminGrace') : t('licence.memberGrace')}
      </Banner>
    );
  }
  return (
    <Banner
      tone="error"
      role="status"
      title={t('licence.inactiveTitle')}
      actions={access.isAdmin ? <Link href="/admin/billing">{t('licence.reactivate')}</Link> : undefined}
    >
      {t('licence.inactiveBody')}
    </Banner>
  );
}
