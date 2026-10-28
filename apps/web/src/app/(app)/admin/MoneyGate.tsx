'use client';

import type { ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Banner, PageHeader } from '@/components/ui/Layout';
import { useMe } from '@/lib/me';
import { NoAccess } from '../NoAccess';

/** Clients, rates, budgets and invoices: org admins on a plan with `budgets_invoicing` (Pro). */
export function useMoneyAccess() {
  const { access } = useMe();
  return { admin: access.isAdmin, entitled: access.entitlements.includes('budgets_invoicing') };
}

export function MoneyGate({ title, children }: { title: string; children: ReactNode }) {
  const { admin, entitled } = useMoneyAccess();
  if (!admin) return <NoAccess what={`${title} are managed by org admins.`} />;
  if (!entitled)
    return (
      <>
        <PageHeader eyebrow="Admin · Money" title={title} />
        <Banner
          title="Part of the Pro plan"
          actions={
            <ButtonLink href="/admin/billing" size="sm">
              See plans
            </ButtonLink>
          }
        >
          Clients, pay and bill rates, project budgets, invoices and payroll export are included in Pro.
        </Banner>
      </>
    );
  return <>{children}</>;
}
