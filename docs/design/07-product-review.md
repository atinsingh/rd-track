# Product review: role workspaces and a shared engine

Status: accepted direction · 2026-10-29 · Inputs: a persona-by-persona walk-through of the
web app, API, agent and docs (senior product review), and the owner's direction that
"the app should not be a bunch of screens; it should have a proper engine and UIs for
every role".

Privacy rules and declined features are unchanged (see `06-stage-4-scope.md`). Platform
operators **manage, not read**: no tenant activity, apps or screenshots without a
time-boxed support grant approved by the tenant (decided 2026-10-29).

## 1. What the review found

1. **Only one email exists** (signup verification). No invites, password resets,
   approval emails or billing-lifecycle emails. In-app notifications only show on
   `/me/privacy`.
2. **No account self-service.** No forgot-password, no password / email / time-zone
   change, no MFA recovery. An org admin who loses their phone is locked out.
3. **Onboarding is manual.** Admins hand out one-time passwords and per-person
   enrolment codes. There is no agent download in the web app, no CSV import, no
   self-enrolment and no setup checklist.
4. **Every role lands on "My day".** Admins, auditors and finance people who don't
   track see "Tracking is off for your account". Money needs full `org_admin`.
5. **The operator realm breaks manage-not-read.** Tenant creation returns the tenant
   admin's password to the operator, and support grants exist only as a table.

Verified in code before accepting: tenant creation returns `admin_initial_password`
(`platform/routes.ts`); the inbox and badge loaded corrections only for team managers
although the API returns them to admins (fixed 2026-10-29); the licence banner claimed
"Your org admin has been notified" with no notification sent (wording fixed 2026-10-29).

## 2. Gaps

P0 blocks selling or using the product, P1 is expected by buyers, P2 is nice to have.

| ID | Persona | Gap | Effort | Pri |
|---|---|---|---|---|
| G1 | Operator | Tenant creation returns the tenant admin's password to the operator | S | P0 |
| G2 | Operator | Support grants: no request, approval, expiry or tenant-side audit | M | P0 |
| G3 | All | No forgot / reset password | S | P0 |
| G4 | Admin | No invite flow; admins hand over a one-time password, never forced to change | M | P0 |
| G5 | Admin | Mandatory admin MFA with no recovery codes and no admin reset | S | P0 |
| G6 | Admin | No trial-ending / payment-failed / grace / inactive emails | S | P0 |
| G7 | All | No notification bell or unread count; pages promise notifications that never come | M | P0 |
| G8 | Emp / Mgr | No notification for corrections, timesheet submitted, deletion decided, device revoked or permission denied | S each | P0 |
| G9 | Admin | Corrections from people with no manager never reached admins in the inbox — **fixed** | S | P0 |
| G10 | Admin / Emp | No agent download in the web app; unsigned installers; updater placeholder; no autostart | M | P0 |
| G11 | Buyer | No terms / DPA acceptance at signup | S | P0 |
| G12 | Admin | Enrolment codes admin-only, one per person; no deep link; no self-enrolment | M | P1 |
| G13 | Emp | No account settings page (name, time zone, password, email, notification preferences, MFA opt-in) | M | P1 |
| G14 | Admin | People page can't edit role / name / time zone, reactivate, search or import CSV | S/M | P1 |
| G15 | Admin | Teams, projects and tasks can't be renamed or archived; project members can't be removed | S | P1 |
| G16 | Admin | No setup checklist after signup | M | P1 |
| G17 | Admin | No tenant export, contract-end deletion or deletion certificate | M | P1 |
| G18 | Emp | Deletion requests cover screenshots only; no "download my data" | M | P1 |
| G19 | Manager | No timesheet due dates, reminders or escalation | M | P1 |
| G20 | Org admin | No organization-wide summary without being a manager | M | P1 |
| G21 | Finance | No finance role; Money needs full `org_admin` | M | P1 |
| G22 | Finance | Payroll export buried in Rates and budgets | S | P1 |
| G23 | Finance | Invoices have no paid state and no send-to-client | S/M | P1 |
| G24 | Auditor | Audit filter by raw UUID; no person filter; no CSV export; auditor lands on My day | S | P1 |
| G25 | Integrations | Webhooks cover 4 events | S | P1 |
| G26 | Admin | SSO / SCIM (P1), MDM packages and tenant logo (P2) promised but missing | L | P1/P2 |
| G27 | All | Hard-coded English; mixed date and money formats | M | P2 |
| G28 | Admin | Deletion requests outside the unified inbox | S | P2 |
| G29 | Eng | `notify.policy_expansion` job kind with no producer or handler | S | P2 |

## 3. The engine (build once, every role uses it)

What exists and stays: `audit()` (the compliance log, kept separate), the Postgres job
queue with recurring jobs (ADR-0002), `emitEvent` for webhooks, a `notifications` table
with four separate in-app writers, a text-only email sender, three pending endpoints plus
`POST /v1/approvals/batch`, and `DataState`.

1. **Domain events.** One `domain_events` outbox, written in the same transaction as the
   change, with a typed catalogue in `@rd/contracts`: `correction.*`, `timesheet.*`,
   `time_off.*`, `idle.decided`, `budget.threshold`, `device.*`, `billing.*`, `user.*`,
   `support_grant.*`. One dispatch job fans out to webhooks, notifications, work items and
   rules. `emitEvent` becomes a consumer.
2. **Notifications.** One `notify(event, recipients)` replacing the four writers:
   recipient resolution, per-category preferences with mandatory (unmutable) categories
   for security and data-collection changes, in-app plus email (HTML and text), optional
   digests. A bell with an unread count in the shell. Emails carry links only, never
   activity data.
3. **Work items.** A `work_items` projection for anything waiting on someone: approvals
   (with a resolved reviewer, falling back to org admins so nothing is orphaned) and
   employee to-dos (decide an idle span, fix a returned correction, submit the week).
   It feeds the inbox, badges and every role home. `POST /v1/approvals/batch` stays the
   action endpoint.
4. **Rules.** A small set of constrained templates in org settings, run by recurring
   jobs: deadlines ("timesheets due Monday 10:00"), reminders, escalation after N hours,
   trial and grace milestones, device offline for N working days (the employee is told
   first). Rules never act on activity levels.
5. **Consistent states.** A `PlanGate` component and an `entitlement_required` error
   code next to `DataState`: every page gets the same empty, loading, error and
   plan-gated states.

## 4. Role workspaces (built on the engine)

`/` routes to the home for the person's role, with a view switcher in the rail for
people with several roles. Each home is assembled from the work-item and notification
feeds, not page-specific queries.

| Role | Home | What it's for |
|---|---|---|
| Employee | `/me` Today | Agent status and last sync; today's timeline; to-dos (idle decisions, returned corrections, submit the week); time-off balance; what's collected and who viewed it |
| Team manager | `/team` Today | Inbox by type and due date; who's on leave or late; team hours vs expected (5+ people, counts only); budget alerts; weekly report |
| Org admin | `/admin` Setup and health | Setup checklist; seats and licence; device health counts; items without a reviewer and deletion requests; offboarding |
| Finance | `/money` Period close | Approved vs pending hours this pay period; payroll export; draft invoices to issue or mark paid; unbilled hours; budgets near or over |
| Auditor | `/audit` | Recent sensitive access; saved filters by person or action; CSV export |
| Operator | `/platform` | Tenants by state (trial ending, past due, grace); plans and seats; support grants; health. Never tenant activity |

## 5. Build order

Stage 4 F4/F3 (agent notices) finishes first. Then:

1. **Engine foundation and trust fixes.** Domain events, the notify service with email
   templates, the bell and preferences, billing-lifecycle emails (G6–G8); terms
   acceptance at signup (G11).
2. **Identity on the engine.** Invites (also removes the operator-visible password, G1),
   password reset, MFA recovery codes and admin MFA reset, account settings (G3–G5, G13).
3. **Work items and rules.** The server-side inbox with reviewer fallback, deletion
   requests in it, employee to-dos, timesheet deadlines and escalation, device-health
   alerts, a larger webhook catalogue (G19, G25, G28).
4. **Role workspaces.** Role homes; admin checklist; agent download and self-enrolment;
   complete People and Teams pages; finance role and Money home; auditor tools;
   organization summary (G10, G12, G14–G16, G20–G24).
5. **Platform console and data lifecycle.** The operator console (`/platform`) with
   support grants end to end, tenant offboarding with export and deletion certificate,
   employee data export and erasure (G2, G17, G18). Then SSO / SCIM (G26).

The remaining Stage 4 features (F5 API tokens, F6 expected hours, F7 expenses, F8 payroll
adjustments, F9 polish) slot in after slice 3, since expenses and tokens both depend on
work items and notifications.
