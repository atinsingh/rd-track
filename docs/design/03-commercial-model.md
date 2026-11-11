# RoundDigital Track — Commercial Model, Licensing and Multi-Tenancy

**Status:** Proposal for review · **Date:** 2026-10-28

RoundDigital Track is sold to other companies as a multi-tenant SaaS, priced per user.
RoundDigital itself is just the first tenant. This document specifies the plans, what
counts as a seat, how licences are enforced, and what that means for the platform.
Prices are a **proposal** to validate with RoundDigital's sales and finance team.

## 1. Positioning

Competitors sell monitoring depth. Track sells **trustworthy time and activity records
that employees accept**: transparent by default, no keystroke content, screenshots off
unless a written policy turns them on, and employees see what their managers see. Two
rules keep that position credible:

1. **Privacy protections are never an upsell.** Every plan includes employee self-service
   ("My day", "What's collected", "Who viewed my data"), corrections, deletion
   requests, audit of sensitive access, and retention enforcement.
2. **Billing never causes covert or interrupted collection.** No plan state ever turns on
   collection; a lapsed licence stops collection visibly and never deletes data without
   the contractual notice period.

## 2. Plans and prices

Prices per **billable seat** (§3) per month, USD, as decided by RoundDigital on 2026-10-28.
Terms confirmed on 2026-10-29: an annual term is half the month-to-month price.

| | **Free** | **Standard** | **Pro** |
|---|---|---|---|
| Annual term | $0 | **$2.50** per user / month ($30 per user / year) | **$5** per user / month ($60 per user / year) |
| Month to month | $0 | **$5** per user / month | **$10** per user / month |
| Billable seats | up to 2 | unlimited | unlimited |
| Work sessions, projects and tasks, idle detection | ✓ | ✓ | ✓ |
| Computer activity (minute aggregates) and app names | ✓ | ✓ | ✓ |
| Employee self-service, corrections, deletion requests | ✓ | ✓ | ✓ |
| Audit of sensitive access, "Who viewed my data" | ✓ | ✓ | ✓ |
| Manager and project reports, CSV export | ✓ | ✓ | ✓ |
| Policy scopes | Organization only | Organization only | Org, team, project, device |
| Optional screenshots (policy-governed) | — | — | ✓ |
| Website domains (the Track browser extension: domain only, during sessions) | — | — | ✓ |
| Approval workflow for corrections | — | ✓ | ✓ |
| REST API and webhooks | — | — | ✓ |
| SSO (OIDC/SAML) and SCIM provisioning | — | — | ✓ |
| Legal hold, custom retention periods | — | — | ✓ |
| Data residency region choice (where a region is offered) | — | — | ✓ |
| MDM deployment packages, staged agent rollout | — | — | ✓ |
| Support | Community / docs | Email | Email + chat |

* **Free means the whole organization has at most 2 billable seats** (people who track
  time; admins, auditors and managers who don't track are free). Adding a third tracked
  user requires a paid plan, and then every billable seat is charged (the first two are
  not free on paid plans). *Confirmed 2026-10-29.*
* **Trial:** 14 days of Pro for new organizations, no card. Screenshots stay off during
  the trial unless the trial admin publishes a screenshot policy.
* **Billing terms** (`subscriptions.billing_interval`):
  * **Annual term**: billed once a year, up front, at the annual price × 12. During the
    term an organization can change seats or plan (prorated by day to the end of the
    term). Moving to month-to-month billing starts at the renewal date;
    the API refuses it earlier with `annual_term_active`. Cancelling keeps the paid term
    to its end, then the organization moves to Free.
  * **Month to month**: billed monthly at the full price; change or cancel at the end of
    any month.
  * A new paid plan is month to month unless the admin picks the annual term. The billing
    page shows the annual price first.
  * Stripe needs four prices: `STRIPE_PRICE_{STANDARD,PRO}_{MONTHLY,ANNUAL}`.
* **Market reference** (third-party summaries, October 2026, re-check before launch):
  Hubstaff $4.99 / $7.50 / $10 per user per month on annual billing (Enterprise about
  $25); Time Doctor about $6.67–$16.70; ActivTrak paid plans from about $10; Insightful from
  about $8. Track at $2.50 / $5 (annual) or $5 / $10 (monthly) undercuts the market's entry price and gives Pro features
  (SSO, screenshots, API) that competitors keep for their top tiers, so self-serve signup,
  automated billing and low support load are essential to the margin.
* **Unit cost sanity check:** with the requirements' capacity model (6 screenshots/hour,
  250 KB, 8 h/day, 30-day retention) one Pro user stores about 0.3 GB of screenshots at any
  time — cents per month in object storage. Compute and support, not storage, dominate
  per-seat cost.

## 3. What is a billable seat

A **billable seat** is a user whose status is `active` **and** `tracking_enabled = true`
(they can start work sessions). Everything else is free:

* Admins, auditors, finance, project managers and team managers who don't track their own time
  are **unlimited free viewer seats**. A manager who also tracks uses one seat.
* Deactivated users free their seat immediately; their records stay under retention.
* Seat usage is measured continuously; invoices use the **peak** number of billable seats
  in the billing period, prorated by day.

## 4. Licence enforcement

Each organization has one `subscription` with `plan`, `seats` (licensed quantity),
`status` and dates. Enforcement is server-side; the web app only reflects it.

| Situation | Behaviour |
|---|---|
| Enabling tracking for a user or enrolling a device for a user without a seat, while `billable ≤ seats` | Allowed. |
| `seats < billable ≤ seats + overage allowance` (allowance = max(2, 10% of seats)) on a paid plan | Allowed with an admin banner; the overage is billed from the day it starts (prorated). |
| Free plan and a third tracked user | `402 plan_upgrade_required` — no overage on Free. |
| Beyond the allowance | `409 seat_limit_reached` when enabling tracking or creating an enrolment code; existing tracked users are **not** affected. Admin is offered "Add seats". |
| Plan lacks a feature (e.g. screenshots on Standard) | The plan acts as an extra, always-restrictive policy scope: `screenshots.enabled = false`, `apps.capture_domains = false`. The policy editor shows the field as "Not in your plan". |
| Downgrade that removes screenshots | Screenshot capture stops at the next policy fetch (restriction, so no confirmation is needed); existing screenshots keep their retention deadline; employees are notified. |
| Payment failed / subscription `past_due` | 14-day **grace**: everything works, admins see a banner, heartbeat reports `license.status = grace`. |
| Grace ended → `inactive` | Agents get `403 subscription_inactive`: they stop the session locally with a visible notice and collect nothing. Web stays readable (read-only) and exports keep working for 90 days. Retention jobs keep running. |
| Contract ended | After the notice period in the contract (default 90 days), tenant data is deleted by the offboarding job and a deletion certificate is issued. |

## 5. Multi-tenancy (platform implications)

See [ADR-0004](../adr/0004-multi-tenant-saas.md).

* **Tenant = organization.** Every business table already carries `organization_id`;
  every query is scoped by it in the service layer, and tenant-isolation tests cover every
  read route. Postgres row-level security on tenant tables is the defence-in-depth layer
  (API connects as a role whose RLS policies require `organization_id =
  current_setting('app.org_id')`; workers use a separate role and always pass the org).
* **Platform operators** (RoundDigital staff) are a separate realm: `platform_admins`
  table, separate login, mandatory MFA. They can create tenants, change plans/seats, and
  see billing and health metrics. They **cannot** read tenant activity or screenshots.
  Support access to a tenant requires a time-boxed grant approved by that tenant's org
  admin, and every action under it is audited in the tenant's own audit log.
* **Region:** `organizations.region` pins where a tenant's database rows and objects live.
  The first deployment is a single region; residency (Pro) means one deployment
  stack per region, with a global directory that maps login email domains to regions.
* **Branding:** the product is "RoundDigital Track". Tenants can upload their own logo,
  shown next to the product mark in the navigation rail (P1).
* **Billing provider:** Stripe Billing in production (per-seat subscription quantity,
  invoices, tax, dunning). The API talks to it through a `BillingProvider` interface;
  Stripe webhooks update `subscriptions`. A `manual` provider supports invoiced
  contracts and local development.
* **Noisy neighbours:** per-tenant rate limits on ingestion and exports; per-tenant job
  fairness in the worker (round-robin claim by organization).

## 6. Data model additions

| Table | Fields |
|---|---|
| `subscriptions` | `organization_id` (unique), `plan` (`free`/`standard`/`pro`), `trial_ends_at`, `billing_interval` (`month`/`year`), `seats`, `status` (`trialing`/`active`/`past_due`/`grace`/`inactive`/`canceled`), `current_period_start/end`, `grace_ends_at`, `provider` (`stripe`/`manual`), `provider_customer_id`, `provider_subscription_id`, `price_per_seat_cents` (negotiated override) |
| `seat_usage_daily` | `organization_id`, `day`, `billable_seats`, `viewer_seats` — written nightly; peak per period drives invoices |
| `platform_admins`, `platform_sessions` | Operator realm (separate from tenant users) |
| `support_access_grants` | `organization_id`, `platform_admin_id`, `approved_by`, `expires_at`, `reason` |
| `users.tracking_enabled` | Boolean; defines a billable seat |

## 7. API additions

| Endpoint | Who |
|---|---|
| `GET /v1/billing/subscription` → plan, seats, billable/viewer counts, status, overage allowance, entitlements | Org admin |
| `POST /v1/billing/seats {seats}` → changes quantity via the provider | Org admin |
| `POST /v1/billing/portal` → provider-hosted billing portal URL | Org admin |
| `POST /v1/webhooks/billing/stripe` | Stripe (signature-verified) |
| `POST /platform/v1/organizations` (create tenant + first admin invite), `PATCH /platform/v1/organizations/{id}/subscription`, `GET /platform/v1/organizations` | Platform operators |

## 8. Open commercial questions

1. ~~Free tier~~: confirmed 2026-10-29 — organizations with at most 2 tracked users.
2. ~~Annual pricing~~: confirmed 2026-10-29 (annual term at half the monthly price).
   Still open: currency (USD vs CAD for Canadian public sector).
3. Is per-seat peak billing acceptable, or should seats be prepaid?
4. Which regions are needed at launch?
5. Will RoundDigital resell through partners (needs reseller/parent-organization model)?
6. Legal: master subscription agreement, DPA, sub-processor list — needed before the first
   external customer.
