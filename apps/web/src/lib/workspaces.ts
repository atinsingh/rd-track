import type { InvoiceSummaryDTO, SetupStep, SetupStepKey } from '@rd/contracts';
import { formatDuration } from './format';
import { t, type MessageKey } from './i18n';

/** Where each setup step is done (G16). Done-ness comes from the server, computed from the data. */
const SETUP_HREF: Record<SetupStepKey, string> = {
  turn_on_mfa: '/me/settings',
  review_policy: '/admin/policies',
  invite_people: '/admin/users',
  create_team: '/admin/teams',
  connect_computer: '/admin/devices',
  timesheet_deadline: '/admin/work-limits',
  choose_plan: '/admin/billing',
};

/** What a setup step asks for, in the reader's language. */
export function setupCopy(key: SetupStepKey): { title: string; body: string; href: string; action: string } {
  const k = (part: string) => t(`mgr.setup.${key}.${part}` as MessageKey);
  return { title: k('title'), body: k('body'), href: SETUP_HREF[key], action: k('action') };
}

/** Required steps done out of required steps; optional ones never hold the checklist open. */
export function setupProgress(steps: readonly SetupStep[]): { done: number; total: number; complete: boolean } {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  return { done, total: required.length, complete: done === required.length };
}

/** "2h 10m more than last week", "35m less than last week", "Same as last week". */
export function weekDelta(current: number, previous: number): string {
  const d = current - previous;
  if (Math.abs(d) < 60) return t('mgr.delta.same');
  return t(d > 0 ? 'mgr.delta.more' : 'mgr.delta.less', { d: formatDuration(Math.abs(d)) });
}

export type InvoiceState = 'draft' | 'unpaid' | 'overdue' | 'paid' | 'void';

export function invoiceState(i: Pick<InvoiceSummaryDTO, 'status' | 'paid_on' | 'due_date'>, today: string): InvoiceState {
  if (i.status === 'draft' || i.status === 'void') return i.status;
  if (i.paid_on) return 'paid';
  return i.due_date && i.due_date < today ? 'overdue' : 'unpaid';
}

export const INVOICE_STATE_LABEL: Record<InvoiceState, string> = { draft: 'Draft', unpaid: 'Unpaid', overdue: 'Overdue', paid: 'Paid', void: 'Void' };

/** Totals per currency, never added across currencies. */
export function totalsByCurrency(items: readonly Pick<InvoiceSummaryDTO, 'currency' | 'total_cents'>[]): { currency: string; total_cents: number }[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.currency, (m.get(i.currency) ?? 0) + i.total_cents);
  return [...m].map(([currency, total_cents]) => ({ currency, total_cents })).sort((a, b) => a.currency.localeCompare(b.currency));
}
