'use client';

import { Card } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatRate } from '@/lib/money';
import { formatDayLabel } from '@/lib/time';
import { useApi } from '@/lib/useApi';

/** The employee's own pay rate (Pro). Nothing renders when no rate is set. */
export function MyPayRate() {
  const { access } = useMe();
  const res = useApi(access.entitlements.includes('budgets_invoicing') ? 'me:pay-rate' : null, (signal) => rd.money.myPayRate(signal));
  const r = res.data;
  if (!r || (!r.current && !r.upcoming)) return null;
  return (
    <Card title="My pay rate" subtitle="Only you and org admins can see this; admin views appear in your access log">
      {r.current ? (
        <p>
          <strong className="mono">{formatRate(r.current.amount_cents, r.current.currency)}</strong> since {formatDayLabel(r.current.effective_from)}
        </p>
      ) : null}
      {r.upcoming ? (
        <p className="secondary">
          Changes to <span className="mono">{formatRate(r.upcoming.amount_cents, r.upcoming.currency)}</span> on {formatDayLabel(r.upcoming.effective_from)}
        </p>
      ) : null}
    </Card>
  );
}
