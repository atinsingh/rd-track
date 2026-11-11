import { z } from 'zod';
import type { PlanId } from './plans';

// Platform operator console and support grants (slice 5a, G2). Operators manage tenants
// but don't read them: no activity, apps, screenshots or money, ever. With a support grant
// the tenant approved, an operator may read configuration for a few hours; every read is
// in the tenant's audit log.

export const SUPPORT_GRANT_MAX_HOURS = 72;
export const supportGrantRequest = z.strictObject({
  reason: z.string().trim().min(10).max(1000),
  hours: z.number().int().min(1).max(SUPPORT_GRANT_MAX_HOURS).default(4),
});

/** `active` and `expired` are worked out from an approved grant's expiry. */
export type SupportGrantState = 'pending' | 'active' | 'expired' | 'denied' | 'ended';

export interface SupportGrantDTO {
  id: string;
  organization_id: string;
  organization_name: string;
  operator_name: string;
  reason: string;
  requested_hours: number;
  state: SupportGrantState;
  created_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  expires_at: string | null;
  ended_at: string | null;
  ended_by: 'tenant' | 'operator' | null;
}

/** What support can read under an active grant. */
export const SUPPORT_SECTIONS = ['people', 'teams', 'devices', 'policies', 'audit'] as const;
export type SupportSection = (typeof SUPPORT_SECTIONS)[number];

export interface PlatformTenantDTO {
  id: string;
  name: string;
  slug: string;
  region: string;
  plan: PlanId;
  status: 'trialing' | 'active' | 'past_due' | 'grace' | 'inactive' | 'canceled';
  seats: number;
  billable_seats: number;
  viewer_seats: number;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  created_at: string;
  /** Health counts only: how many people and connected computers, and when any last synced. */
  people: number;
  devices: number;
  last_sync_at: string | null;
  support_active: boolean;
  support_pending: boolean;
  /** Set while the organization is closing (slice 5b). */
  deletion_scheduled_at: string | null;
}

export interface PlatformTenantDetail extends PlatformTenantDTO {
  price_per_seat_cents: number | null;
  billing_interval: 'month' | 'year';
  current_period_end: string | null;
  devices_stale: number;
  agent_versions: { version: string; count: number }[];
  grants: SupportGrantDTO[];
}

export interface PlatformMe {
  id: string;
  email: string;
  display_name: string;
  mfa_verified: boolean;
}
