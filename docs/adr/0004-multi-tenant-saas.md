# ADR-0004: Multi-tenant SaaS with per-seat licensing

**Status:** Accepted · 2026-10-28

## Context

RoundDigital will sell Track to other companies: Free up to 2 users, Standard $2.50 and Pro $5 per user per month. The original
requirements described a single-company deployment.

## Decision

* One shared deployment per region serves many tenants; a tenant is an `organization`.
* Isolation is enforced twice: service-layer scoping by `organization_id` on every query
  (with tenant-isolation tests on every read route), and Postgres row-level security as
  defence in depth.
* Vendor staff use a separate **platform** realm with no default access to tenant data.
* Plans are data (`packages/contracts/src/plans.ts`): entitlements and limits are looked up
  from the plan, and a plan acts as an always-restrictive policy scope so feature gating
  reuses the policy resolver instead of adding `if (plan === …)` checks around the code.
* Billing goes through a `BillingProvider` interface (Stripe in production, `manual` for
  invoiced contracts and development).

## Consequences

* Every new table needs `organization_id` plus an RLS policy, and every new read route
  needs a tenant-isolation test — enforced in code review.
* Licence state is part of the agent contract (`403 subscription_inactive`,
  `seat_unavailable`), so lapses stop collection visibly instead of silently.
* Single-tenant (dedicated) deployments for large customers remain possible with the same
  code: it's the multi-tenant build with one organization.
