import { PLANS, monthsPerInvoice, type BillingInterval, type PlanId } from '@rd/contracts';
import { formatMoney } from './format';

/** "$2.50" or "$5" — whole dollars without cents. */
export const price = (cents: number) => formatMoney(cents).replace(/\.00$/, '');

/** How a seat price reads for a term: "$2.50 per user / month, billed annually". */
export function seatPriceText(cents: number, interval: BillingInterval): string {
  if (cents === 0) return '$0';
  return interval === 'year' ? `${price(cents)} per user / month, billed annually` : `${price(cents)} per user / month`;
}

/** What one invoice comes to for `seats` seats on a plan and term. */
export function invoiceCents(plan: PlanId, interval: BillingInterval, seats: number): number {
  return PLANS[plan].prices[interval] * seats * monthsPerInvoice(interval);
}

/** The annual saving against month to month, as a whole percentage (50 with today's prices). */
export function annualSavingPercent(plan: PlanId): number {
  const { month, year } = PLANS[plan].prices;
  return month === 0 ? 0 : Math.round((1 - year / month) * 100);
}
