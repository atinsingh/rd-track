'use client';

import type { ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Banner, PageHeader } from '@/components/ui/Layout';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';
import { NoAccess } from '../NoAccess';

/** Clients, rates, budgets, invoices and payroll: org admins and finance, on a plan with `budgets_invoicing` (Pro). */
export function useMoneyAccess() {
  const { access } = useMe();
  return { admin: access.isAdmin || access.isFinance, entitled: access.entitlements.includes('budgets_invoicing') };
}

export function MoneyGate({ title, children }: { title: string; children: ReactNode }) {
  const { admin, entitled } = useMoneyAccess();
  if (!admin) return <NoAccess what={t('money.gate.noAccess', { title })} />;
  if (!entitled)
    return (
      <>
        <PageHeader eyebrow={t('money.gate.eyebrow')} title={title} />
        <Banner
          title={t('money.gate.proTitle')}
          actions={
            <ButtonLink href="/admin/billing" size="sm">
              {t('money.gate.seePlans')}
            </ButtonLink>
          }
        >
          {t('money.gate.proBody')}
        </Banner>
      </>
    );
  return <>{children}</>;
}
