'use client';

import Link from 'next/link';
import { Banner } from '@/components/ui/Layout';
import { useMe } from '@/lib/me';

/** Licence state from GET /v1/me (commercial model §4). Billing never hides collection. */
export function LicenceBanner() {
  const { me, access } = useMe();
  const license = me.organization.license;
  if (license === 'active') return null;
  if (license === 'grace') {
    return (
      <Banner
        tone="warn"
        role="status"
        title="Payment is overdue — grace period"
        actions={access.isAdmin ? <Link href="/admin/billing">Open billing →</Link> : undefined}
      >
        Everything keeps working for now.{' '}
        {access.isAdmin
          ? 'Update payment before the grace period ends, or tracking stops for everyone.'
          : 'Your org admin can settle this from the billing page.'}
      </Banner>
    );
  }
  return (
    <Banner
      tone="error"
      role="status"
      title="Subscription inactive — nothing is being collected"
      actions={access.isAdmin ? <Link href="/admin/billing">Reactivate in billing →</Link> : undefined}
    >
      Agents have stopped tracking and show a notice. Existing records stay readable and exports keep working.
    </Banner>
  );
}
