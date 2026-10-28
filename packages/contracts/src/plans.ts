import type { PartialPolicySettings } from './policy';

/**
 * Plan catalog (commercial model §2). Plans are data: entitlements gate API
 * features, and `policyScope` is applied as an always-on restrictive policy scope
 * so that plan limits flow through the same resolver as every other policy.
 */

export const PLAN_IDS = ['free', 'standard', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const ENTITLEMENTS = [
  /** team / project / device policy scopes (organization scope is always available) */
  'scoped_policies',
  'screenshots',
  'domains',
  'correction_approvals',
  'api_access',
  'sso',
  'legal_hold',
  /** retention longer than the default periods; shortening is allowed on every plan */
  'extended_retention',
  'data_residency',
  'mdm',
  /** weekly timesheets with submit/approve, limits and overtime */
  'timesheets',
  'time_off',
  /** pay/bill rates, project budgets, clients, invoices, payroll export */
  'budgets_invoicing',
  'schedules',
  /** team-level (aggregate) insights; personal insights are on every plan */
  'team_insights',
  'webhooks',
] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

/** Billing term: month to month, or an annual term at half the monthly price. */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  /** Price per billable seat per month, in US cents, by billing term (an annual term is billed 12× up front). */
  prices: Record<BillingInterval, number>;
  /** Maximum billable seats; null = unlimited. */
  max_billable_seats: number | null;
  /** Whether billable seats may exceed licensed seats by the overage allowance. */
  allows_overage: boolean;
  entitlements: readonly Entitlement[];
  policyScope: PartialPolicySettings;
}

const BASE_RESTRICTIONS: PartialPolicySettings = {
  screenshots: { enabled: false },
  apps: { capture_domains: false, capture_window_titles: false },
  retention: { screenshot_days: 30, activity_days: 90, app_usage_days: 90 },
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    prices: { month: 0, year: 0 },
    max_billable_seats: 2,
    allows_overage: false,
    entitlements: [],
    policyScope: BASE_RESTRICTIONS,
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    prices: { month: 500, year: 250 },
    max_billable_seats: null,
    allows_overage: true,
    entitlements: ['correction_approvals', 'timesheets', 'time_off'],
    policyScope: BASE_RESTRICTIONS,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    prices: { month: 1000, year: 500 },
    max_billable_seats: null,
    allows_overage: true,
    entitlements: [...ENTITLEMENTS],
    // Window titles stay off on every plan: the agent does not implement them.
    policyScope: { apps: { capture_window_titles: false } },
  },
};

export const TRIAL_PLAN: PlanId = 'pro';
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 14;

/** Per seat per month for the term; `override` is a negotiated price that replaces the list price. */
export function seatPriceCents(plan: PlanId, interval: BillingInterval, override?: number | null): number {
  return override ?? PLANS[plan].prices[interval];
}

/** Months charged per invoice for the term. */
export function monthsPerInvoice(interval: BillingInterval): number {
  return interval === 'year' ? 12 : 1;
}

export function hasEntitlement(plan: PlanId, e: Entitlement): boolean {
  return PLANS[plan].entitlements.includes(e);
}

/** Seats that may be in use before enabling more tracking is refused. */
export function seatCeiling(plan: PlanId, licensedSeats: number): number {
  const p = PLANS[plan];
  if (p.max_billable_seats !== null) return p.max_billable_seats;
  if (!p.allows_overage) return licensedSeats;
  return licensedSeats + Math.max(2, Math.ceil(licensedSeats * 0.1));
}

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'grace', 'inactive', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Licence state reported to agents and used to gate collection. */
export type LicenseState = 'active' | 'grace' | 'inactive';

export function licenseState(status: SubscriptionStatus): LicenseState {
  switch (status) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
    case 'grace':
      return 'grace';
    case 'inactive':
    case 'canceled':
      return 'inactive';
  }
}
