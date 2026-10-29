'use client';

import { PAYROLL_ADJUSTMENT_LABELS } from '@rd/contracts';
import m from '@/app/(app)/admin/money.module.css';
import { Card } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useMe } from '@/lib/me';
import { adjustmentWhen, formatRate } from '@/lib/money';
import { formatDayLabel } from '@/lib/time';
import { useApi } from '@/lib/useApi';

/** The employee's own pay rate and bonuses, deductions and reimbursements (Pro). Nothing renders when none is set. */
export function MyPayRate() {
  const { access } = useMe();
  const money = access.entitlements.includes('budgets_invoicing');
  const res = useApi(money ? 'me:pay-rate' : null, (signal) => rd.money.myPayRate(signal));
  const adj = useApi(money ? 'me:payroll-adjustments' : null, (signal) => rd.money.myAdjustments(signal));
  const r = res.data;
  const extras = adj.data ?? [];
  if ((!r || (!r.current && !r.upcoming)) && !extras.length) return null;
  return (
    <Card title="My pay" subtitle="Only you and org admins can see this; admin views appear in your access log">
      {r?.current ? (
        <p>
          <strong className="mono">{formatRate(r.current.amount_cents, r.current.currency)}</strong> since {formatDayLabel(r.current.effective_from)}
        </p>
      ) : null}
      {r?.upcoming ? (
        <p className="secondary">
          Changes to <span className="mono">{formatRate(r.upcoming.amount_cents, r.upcoming.currency)}</span> on {formatDayLabel(r.upcoming.effective_from)}
        </p>
      ) : null}
      {extras.length ? (
        <>
          <span className="label-mono">Bonuses, deductions and reimbursements</span>
          <ul className={m.history}>
            {extras.slice(0, 8).map((a) => (
              <li key={a.id}>
                <span>
                  {PAYROLL_ADJUSTMENT_LABELS[a.kind]} · {a.note}
                  <span className="small muted" style={{ display: 'block' }}>
                    {adjustmentWhen(a)}
                  </span>
                </span>
                <span className="mono">
                  {a.kind === 'deduction' ? '−' : ''}
                  {formatMoney(a.amount_cents, a.currency)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
