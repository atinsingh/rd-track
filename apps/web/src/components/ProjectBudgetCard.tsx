'use client';

import { BudgetMeter } from '@/components/BudgetMeter';
import { Card } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { useApi } from '@/lib/useApi';

/** Budget status for a project manager's project (Pro). Nothing renders without a budget. */
export function ProjectBudgetCard({ projectId }: { projectId: string }) {
  const { access } = useMe();
  const res = useApi(access.entitlements.includes('budgets_invoicing') ? `budget|${projectId}` : null, (signal) =>
    rd.money.projectBudget(projectId, signal),
  );
  const b = res.data?.budget;
  if (!b) return null;
  return (
    <Card title="Budget" subtitle="Includes agent-tracked and approved manual time">
      <BudgetMeter budget={b} />
    </Card>
  );
}
