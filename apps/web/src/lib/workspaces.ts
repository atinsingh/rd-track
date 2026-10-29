import type { InvoiceSummaryDTO, SetupStep, SetupStepKey } from '@rd/contracts';
import { formatDuration } from './format';

/** What each setup step asks for (G16). Done-ness comes from the server, computed from the data. */
export const SETUP_COPY: Record<SetupStepKey, { title: string; body: string; href: string; action: string }> = {
  turn_on_mfa: {
    title: 'Turn on two-factor sign-in',
    body: 'Your account can change what Track collects, so it needs more than a password.',
    href: '/me/settings',
    action: 'Open settings',
  },
  review_policy: {
    title: 'Decide what Track collects',
    body: 'Idle time, app names and screenshots are each a choice. Employees see exactly what you pick before anything is collected.',
    href: '/admin/policies',
    action: 'Open policies',
  },
  invite_people: {
    title: 'Invite your people',
    body: 'Each person gets an email to choose their own password. You never see it.',
    href: '/admin/users',
    action: 'Invite people',
  },
  create_team: {
    title: 'Create a team and pick its manager',
    body: "Managers review their team's time and requests. Without one, everything comes to you.",
    href: '/admin/teams',
    action: 'Open teams',
  },
  connect_computer: {
    title: 'Connect a computer',
    body: 'Each person installs the Track agent and signs it in with their own enrolment code.',
    href: '/admin/devices',
    action: 'Open devices',
  },
  timesheet_deadline: {
    title: 'Set a timesheet deadline',
    body: 'Optional. Reminds people the day before their week is due, and tells reviewers who is late.',
    href: '/admin/work-limits',
    action: 'Set a deadline',
  },
  choose_plan: {
    title: 'Choose a plan',
    body: 'Your trial includes every feature. Pick monthly or annual before it ends to keep tracking.',
    href: '/admin/billing',
    action: 'See plans',
  },
};

/** Required steps done out of required steps; optional ones never hold the checklist open. */
export function setupProgress(steps: readonly SetupStep[]): { done: number; total: number; complete: boolean } {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  return { done, total: required.length, complete: done === required.length };
}

/** "2h 10m more than last week", "35m less than last week", "Same as last week". */
export function weekDelta(current: number, previous: number): string {
  const d = current - previous;
  if (Math.abs(d) < 60) return 'Same as last week so far';
  return `${formatDuration(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than all of last week`;
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
