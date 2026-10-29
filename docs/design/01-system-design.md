# RoundDigital Track — System Design

**Status:** Draft for review · **Date:** 2026-10-28
**Inputs:** `RoundDigital Workforce Activity & Time Platform` requirements (2026-10-28) and the architecture diagram.
**Requirement IDs** (`TIME-04`, `SCR-07`, …) refer to that document.
**Commercial model:** Track is sold as multi-tenant SaaS (Free up to 2 users, Standard
$2.50 / Pro $5 per user per month on an annual term, $5 / $10 month to month) — see [03-commercial-model.md](03-commercial-model.md)
and [ADR-0004](../adr/0004-multi-tenant-saas.md). RoundDigital is the first tenant.

This document turns the requirements into a buildable design: module boundaries, data
model, wire contracts, the key flows, and the rules that keep time and activity numbers
honest. Decisions that weren't obvious are recorded as ADRs in [`docs/adr`](../adr).

---

## 1. What we are building (and what we are not)

A transparent work-session and time platform. Employees explicitly start and stop
work sessions on a company-managed Windows/macOS device. While a session is active the
agent records **aggregated** computer activity (counts per minute, never content), the
foreground application, and — only when a published policy says so — low-frequency
screenshots. Employees see everything their manager can see about them.

**Wording rule.** The product says **"computer activity"**, never "productivity". An
activity percentage measures device input during measurable session time; it cannot see
meetings, calls, thinking, or reading. Every activity number in the UI links to the
explanation of how it is calculated (`RPT-05`).

**Never collected, enforced in code and schema:** key identities or typed text,
clipboard, selected text, input-field content, webcam, microphone, email/chat/document
bodies, continuous screen recording, location. Event payload schemas are **strict** —
unknown fields are rejected — so a future agent bug cannot smuggle content into storage.

## 2. Architecture

Modular monolith + asynchronous workers ([ADR-0001](../adr/0001-modular-monolith-on-fastify.md)).

```
 Employee ──start/stop──► Desktop agent (Rust core, Tauri shell)
                            │  session state machine · activity aggregator · app tracker
                            │  screenshot scheduler · signed-policy cache · encrypted outbox
                            │
                 TLS, device credential (Authorization: Device …)
                            ▼
 ┌──────────────────────── API (apps/api, one deployment) ─────────────────────────┐
 │ auth · org · devices · policy · sessions · ingestion · activity · screenshots   │
 │ corrections · reports · exports · privacy · audit                               │
 └───────┬─────────────────────────────┬──────────────────────────────┬─────────────┘
         │ SQL (single transaction)    │ enqueue (same transaction)   │ presign only
         ▼                             ▼                              ▼
   PostgreSQL ◄──────────────── Worker (apps/api, worker entry) ──► Object storage
   source of truth              aggregate · verify screenshots       (S3/MinIO, private)
   + jobs table (queue)         exports · retention · notifications  screenshots/ exports/
         ▲
         │ /v1 JSON (cookie session, same-origin)
 Web dashboard (apps/web, Next.js) ◄── Employee / Manager / Admin / Auditor
```

| Component | Location | Notes |
|---|---|---|
| Contracts | `packages/contracts` | Zod schemas for events, policy settings, API DTOs; the policy resolver. Imported by API and web. Rust mirrors the event/policy shapes with serde. |
| API | `apps/api/src/main.ts` | Fastify 5. Every route declares its auth mode (`user`, `device`, `public`). |
| Worker | `apps/api/src/worker.ts` | Same codebase, separate process. Pulls from the Postgres `jobs` queue ([ADR-0002](../adr/0002-postgres-job-queue.md)); runs the retention scheduler. |
| Web | `apps/web` | Next.js App Router. Proxies `/v1/*` to the API so the session cookie stays same-origin. |
| Agent core | `agent/crates/rd-agent-core` | Platform-independent logic, fully unit-tested. OS integrations sit behind traits. |
| Agent binary | `agent/crates/rd-agent` | Headless agent + CLI for enrollment and development; the Tauri UI shell wraps the same core. |
| Local infra | `infra/docker-compose.yml` | Postgres 16 + MinIO. |

### 2.1 API modules and their boundaries

Each module owns its tables. Modules call each other through exported service functions,
never through another module's SQL.

| Module | Owns | Responsibilities |
|---|---|---|
| `auth` | `users.password_hash`, `user_sessions` | Login, TOTP MFA (mandatory for `org_admin`/`super_admin`), logout, cookie sessions. |
| `org` | `organizations`, `users`, `teams`, `team_memberships`, `projects`, `project_memberships`, `tasks` | Admin CRUD. Memberships have `valid_from/valid_to`; moving teams closes one row and opens another (`IAM-07`). |
| `devices` | `enrollment_codes`, `devices` | One-time enrollment codes, device credentials, heartbeat, revoke (`IAM-04/05`, `DEV-01/04`). |
| `policy` | `policies`, `policy_versions`, `policy_receipts` | Versioned partial policies per scope, resolution, signing, expansion detection (`POL-*`). |
| `sessions` | `work_sessions`, `session_transitions` | Lifecycle, overlap prevention, state machine (`TIME-01..07`). |
| `ingestion` | `ingest_events` | Batch validation, idempotency, sequence tracking, inline lifecycle handling, enqueue. |
| `activity` | `activity_buckets`, `app_usage`, `data_gaps` | Worker-side aggregation; read models for dashboards. |
| `screenshots` | `screenshots` | Upload intents, completion, verification, authorized viewing (`SCR-*`). |
| `corrections` | `time_corrections` | Manual time and edits with preserved originals and approval (`TIME-08`). |
| `reports` | — (reads) | Team/project/employee summaries. |
| `exports` | `export_jobs` | Async CSV generation, expiring download (`RPT-04`). |
| `privacy` | `deletion_requests`, `legal_holds`, `notifications` | Deletion workflow, legal hold, employee notices (`AUD-04/05`, `POL-05`). |
| `audit` | `audit_logs` | Append-only writer and reader (`AUD-01/02`). |
| `billing` | `subscriptions`, `seat_usage_daily` | Plan entitlements, seat counting and enforcement, licence status for agents, `BillingProvider` (Stripe / manual). |
| `platform` | `platform_admins`, `platform_sessions`, `support_access_grants` | Vendor operator realm: create tenants, set plan and seats. No access to tenant activity data. |

## 3. Roles and authorization

Roles come from two places: an **organization role** on the user and **scoped roles** from
memberships.

| Role | Source | Can see |
|---|---|---|
| Employee | every user | Own sessions, activity, apps, screenshots, corrections, exports. |
| Team manager | `team_memberships.role = 'manager'` (current rows) | Members of managed teams: time and activity summaries; apps if `viewers.manager_can_view_apps`; screenshots only if the resolved policy for that employee grants `viewers.manager_can_view_screenshots`. Approves members' corrections. |
| Project manager | `project_memberships.role = 'manager'` | Time per member **on managed projects only**; no activity detail, no screenshots. |
| Org admin | `users.org_role = 'org_admin'` | Users, teams, projects, devices, policies, deletion requests, exports. **No screenshot access by default** — an admin who also manages a team gets that team's manager access, nothing more. |
| Auditor | `users.org_role = 'auditor'` | Audit log and access records, filtered by who acted or whose data it was, and CSV export (itself audited). Names only, no emails; no activity detail, no screenshots. |
| Finance | `users.org_role = 'finance'` | Money (Pro): clients, pay and bill rates, budgets, invoices (issue, send to the client, record payment) and payroll export; reads the people and project lists those are set against. No people admin, policies, devices, activity, apps or screenshots. MFA required like admins. |
| Super admin | `users.org_role = 'super_admin'` | Break-glass org administration; MFA mandatory; every action audited with `actor_role = 'super_admin'`. |
| Platform operator | `platform_admins` (separate realm and login) | RoundDigital staff running the SaaS: tenants, plans, seats, billing health. **No** tenant activity, apps or screenshots; support access needs a time-boxed grant approved by the tenant's org admin. |

**Rule enforced in code:** every query receives an `Actor` (`organization_id`, `user_id`,
roles) and filters by `organization_id` first. Access to another user's data goes through
one function, `authz.assertCanView(actor, targetUserId, purpose)`, where `purpose` is one
of `time`, `activity`, `apps`, `screenshots`. A denial returns `404` for objects in another
organization (no existence oracle) and `403` within the organization, and denied
screenshot/export attempts are audited.

## 4. Data model

PostgreSQL 16. All timestamps are `timestamptz` stored in UTC. Every business table
carries `organization_id`. Full DDL lives in `apps/api/src/db/migrations`.

```
organizations ─┬─< users ─┬─< user_sessions
               │          ├─< team_memberships >── teams
               │          ├─< project_memberships >── projects ─< tasks
               │          ├─< devices ─< enrollment_codes(user)
               │          └─< work_sessions ─┬─< session_transitions
               │                              ├─< activity_buckets
               │                              ├─< app_usage
               │                              ├─< data_gaps
               │                              ├─< screenshots
               │                              └─< time_corrections
               ├─< policies ─< policy_versions        ingest_events (device_id, event_id) PK
               ├─< audit_logs (append-only)           jobs (queue)
               ├─< deletion_requests / legal_holds / notifications / export_jobs
```

Key constraints:

| Table | Constraint | Why |
|---|---|---|
| `work_sessions` | `id` is generated by the agent (UUID) | Offline start; idempotent replays. |
| `work_sessions` | partial unique index on `(user_id) WHERE state IN ('active','paused')` | No overlapping sessions (`TIME-07`); policy can relax via `allow_overlapping_sessions`, in which case the server skips the check and the index is per-device. |
| `ingest_events` | PK `(device_id, event_id)` | Replaying a batch inserts nothing new (`ON CONFLICT DO NOTHING`). |
| `activity_buckets` | PK `(session_id, bucket_start)`, `CHECK active_seconds + idle_seconds <= 60` | One row per minute; replays upsert the same row. |
| `screenshots` | `object_key` unique, random; `retention_after NOT NULL` | Unguessable keys; nothing stored without a deletion deadline. |
| `audit_logs` | trigger rejects `UPDATE`/`DELETE` | Append-only (`AUD-01`). Retention of audit rows is a separate, explicit maintenance procedure. |
| `time_corrections` | `original` JSONB is written once | Original values are never lost (`TIME-08`). |

## 5. Wire contracts

All endpoints are under `/v1`, JSON, `snake_case` fields, RFC 3339 UTC timestamps.
Errors: `{ "error": { "code": "session_not_active", "message": "…", "request_id": "…" } }`.
Every response carries `x-request-id`.

### 5.1 Authentication

* **Users:** `POST /v1/auth/login` → sets an `HttpOnly; Secure; SameSite=Strict` cookie
  holding an opaque token (only its SHA-256 is stored). Admin roles get a session with
  `mfa_verified = false` until `POST /v1/auth/mfa/verify` succeeds; privileged routes require
  `mfa_verified`. State-changing requests must carry `x-rd-csrf: 1` (a custom header a
  cross-site form cannot send).
* **Devices:** `Authorization: Device <credential>`. The credential is 32 random bytes,
  issued once at enrollment, stored hashed, revocable. A revoked device gets `401
  device_revoked` on every call and the agent stops collecting.

### 5.2 Agent endpoints

| Endpoint | Request | Response |
|---|---|---|
| `POST /v1/devices/enroll` (public) | `{enrollment_code, device_name, os: "windows"\|"macos"\|"linux", os_version, agent_version}` | `201 {device_id, user_id, organization_id, device_credential, policy_signing_key: {key_id, public_key_b64}}` |
| `POST /v1/device/heartbeat` | `{agent_version, client_time, permissions: {input_monitoring, screen_recording, accessibility}, outbox_depth, applied_policy_revision}` each permission is `granted\|denied\|not_required\|unknown` | `{server_time, policy_revision, credential_status}` |
| `GET /v1/device/policy?project_id=` | — | `{payload_b64, signature_b64, key_id}` — see §6.4 |
| `POST /v1/ingestion/event-batches` | `{batch_id, sent_at, events: Envelope[1..500]}` ≤ 1 MiB | `200 {server_time, results: [{event_id, status: "accepted"\|"duplicate"\|"rejected", reason?}]}` |
| `POST /v1/screenshots/upload-intents` | `{session_id, content_type: "image/webp"\|"image/jpeg"}` | `201 {screenshot_id, upload_url, upload_headers, expires_at}` or `403 {code}` |
| `POST /v1/screenshots/complete` | `{screenshot_id, captured_at, sha256, bytes, width, height}` | `200 {status: "verifying"}` |
| `POST /v1/sessions`, `POST /v1/sessions/{id}/pause\|resume\|stop` | same fields as the lifecycle events | Session object. Equivalent to sending the event; provided for online clients. |
| `GET /v1/device/update?target&arch&current_version` (G10) | — | `200 {version, url, signature, notes, pub_date, mode: "prompt"\|"auto"}` (Tauri's dynamic update format) or `204` when there is nothing to install or the organization holds updates. Admins set the mode with `GET\|PUT /v1/admin/agent-updates` `{mode: "prompt"\|"auto"\|"hold"}`. |

### 5.3 Event envelope

```json
{
  "event_id": "2f0c…",               // UUIDv4 generated by the agent, idempotency key
  "organization_id": "…",            // must match the device; otherwise rejected
  "device_id": "…",                  // must match the credential
  "session_id": "…",
  "policy_version": 12,              // org policy revision the agent was applying
  "event_type": "activity_bucket.v1",
  "occurred_at": "2026-10-28T09:41:00Z",
  "sequence": 1842,                  // per-device, strictly increasing, survives restarts
  "monotonic_ms": 5523000,           // ms since session start on a monotonic clock
  "payload": { }
}
```

| `event_type` | `payload` (strict — unknown keys rejected) |
|---|---|
| `session.started.v1` | `{project_id?, task_id?}` |
| `session.paused.v1` | `{reason: "user"\|"idle_auto"\|"work_hours"}` |
| `session.resumed.v1` | `{}` |
| `session.stopped.v1` | `{reason: "user"\|"logout"\|"shutdown"\|"revoked"\|"policy"\|"overlap"}` |
| `activity_bucket.v1` | `{bucket_start (minute-aligned), active_seconds 0..60, idle_seconds 0..60, keyboard_count, mouse_count, data_quality: "ok"\|"partial"\|"permission_missing"}` with `active + idle ≤ 60` |
| `app_usage.v1` | `{app_identifier, app_name, domain?, started_at, duration_seconds 1..3600}` — `domain` is dropped server-side unless the resolved policy has `apps.capture_domains` |
| `data_gap.v1` | `{gap_start, gap_end, reason: "suspended"\|"offline_agent_stopped"\|"permission_missing"\|"clock_change"}` |

Ingestion processing (in one transaction):

1. Authenticate device; reject the whole batch if the device is revoked or the user is
   deactivated, and with `403 subscription_inactive` / `seat_unavailable` when the
   organization's licence doesn't cover this user (commercial model §4).
2. Validate each envelope; invalid ones are `rejected` with a reason (no payload is logged).
3. `INSERT … ON CONFLICT DO NOTHING` into `ingest_events`; conflicts are `duplicate`.
4. Lifecycle events (`session.*`) are applied **inline**, in `sequence` order, through the
   sessions service — so screenshot authorization sees the new state immediately. An
   overlap rejects `session.started.v1` with `overlapping_session`; later events for that
   session are rejected `unknown_session`, and the agent shows the employee why.
5. Remaining accepted events go into one `ingest.process` job.
6. Sequence gaps (`sequence > last_sequence + 1`) are recorded on the device for health
   reporting; they never block ingestion.

Commit happens before the response, so an acknowledged event is durable (§12, "no
acknowledged event loss").

### 5.4 Web endpoints (cookie auth)

Response and request types live in `packages/contracts/src/api.ts`. Lists return
`{ "items": [...] }`. Mutations require the `x-rd-csrf: 1` header.

| Area | Endpoint → response |
|---|---|
| Auth | `POST /v1/auth/login` `{email,password}` → `LoginResponse` (sets cookie) · `POST /v1/auth/mfa/verify` `{code}` · `POST /v1/auth/mfa/enroll` → `MfaEnrollResponse` · `POST /v1/auth/mfa/enroll/confirm` `{code}` · `POST /v1/auth/logout` |
| Me | `GET /v1/me` → `Me` · `GET /v1/me/sessions?from&to` → `SessionDTO[]` · `GET /v1/me/activity?from&to` → `ActivityResponse` · `GET /v1/me/apps?from&to` → `AppUsageResponse` · `GET /v1/me/screenshots?from&to` → `ScreenshotDTO[]` · `GET /v1/me/corrections` → `CorrectionDTO[]` · `POST /v1/me/time-corrections` → `CorrectionDTO` · `POST /v1/me/deletion-requests` → `DeletionRequestDTO` · `GET /v1/me/notifications` · `POST /v1/me/notifications/{id}/read` · `GET /v1/me/policy` → `MyPolicyResponse` · `GET /v1/me/access-log` → `AuditEventDTO[]` (who viewed my data) · `GET /v1/me/projects` → `ProjectDTO[]` |
| People I may view | `GET /v1/users/{id}/sessions\|activity\|apps\|screenshots?from&to` (same shapes as Me; `authz.assertCanView`) · `GET /v1/screenshots/{id}/view-url` → `ViewUrlResponse` (60 s, audited) |
| Team / project | `GET /v1/teams` → `TeamSummary[]` (managed) · `GET /v1/teams/{id}/report?from&to&tz` → `TeamReport` · `GET /v1/projects` → `ProjectDTO[]` (managed) · `GET /v1/projects/{id}/report?from&to` → `ProjectReport` |
| Corrections | `GET /v1/corrections/pending` → `CorrectionDTO[]` · `POST /v1/corrections/{id}/approve\|reject` `{note?}` |
| Exports | `POST /v1/exports` → `ExportDTO` · `GET /v1/exports` · `GET /v1/exports/{id}` |
| Admin | `GET/POST /v1/admin/users` (`POST` → `{user, initial_password?}`) · `PATCH /v1/admin/users/{id}` · `POST /v1/admin/users/{id}/deactivate` · `GET/POST /v1/admin/teams` · `POST /v1/admin/teams/{id}/members` · `DELETE /v1/admin/teams/{id}/members/{user_id}` · `GET/POST /v1/admin/projects` · `POST /v1/admin/projects/{id}/tasks` · `POST /v1/admin/projects/{id}/members` · `POST /v1/admin/enrollment-codes` → `EnrollmentCodeResponse` · `GET /v1/admin/devices` → `DeviceDTO[]` · `POST /v1/admin/devices/{id}/revoke` · `GET /v1/admin/deletion-requests` · `POST /v1/admin/deletion-requests/{id}/approve\|reject` · `POST /v1/admin/legal-holds` |
| Policies | `GET /v1/policies` → `PolicyListResponse` · `GET /v1/policies/{scope_type}/{scope_id}` → `PolicyScopeDetail` · `PUT /v1/policies/{scope_type}/{scope_id}` `{settings, change_note, confirm_expansion}` → `PolicyScopeDetail`, or `409 expansion_requires_confirmation` (details: `ExpansionConflict`), or `402 plan_upgrade_required` |
| Billing | `GET /v1/billing/subscription` → `SubscriptionDTO` · `POST /v1/billing/plan` `{plan, seats}` → `SubscriptionDTO` |
| People and structure | `PATCH /v1/admin/users/{id}`, `POST /v1/admin/users/{id}/reactivate`, `POST /v1/admin/users/import` (`dry_run`), `PATCH /v1/admin/teams/{id}`, `POST /v1/admin/teams/{id}/archive`, `PATCH /v1/admin/projects/{id}`, `PATCH /v1/admin/projects/{id}/tasks/{taskId}`, `DELETE /v1/admin/projects/{id}/members/{userId}` (org admin) |
| Organization data | `GET /v1/admin/organization`, `POST /v1/admin/organization/close` (`confirm_name`), `POST …/close/cancel`, `GET|POST /v1/admin/data-exports` (org admin); `GET /platform/v1/deletion-certificates` (operator) |
| Your data and erasure | `GET|POST /v1/me/data-exports` (a ZIP of everything about me), `GET|POST /v1/me/erasure-request` (`reason?`; `409 erasure_pending`); `GET /v1/admin/erasure-requests`, `POST …/{id}/approve`, `POST …/{id}/decline` (`reason`) (org admin, never their own) |
| API tokens | `GET|POST /v1/api-tokens` (`name`, `kind`, `scopes`, `expires_in_days`; the secret is returned once), `POST /v1/api-tokens/{id}/revoke`; `GET /v1/docs` (reference), `GET /v1/docs/openapi.json`. Calls with `Authorization: Bearer rdt_…` reach only the endpoints in the reference: `401 invalid_token`, `403 insufficient_scope`, `403 not_in_api` |
| Expenses (Pro) | `POST /v1/me/expenses/receipt-uploads` (`content_type`, `size_bytes` ≤ 10 MB) → `ReceiptUploadResponse` (presigned PUT, 10 min), `GET /v1/me/expenses?from` → `MyExpensesResponse`, `POST /v1/me/expenses` (`amount_cents`, `currency`, `spent_on`, `category`, `project_id?`, `billable`, `note`, `receipt_upload_id?`), `POST /v1/me/expenses/{id}/cancel`; reviewers: `GET /v1/expenses/pending`, `POST /v1/expenses/{id}/approve` (`note?`), `POST /v1/expenses/{id}/reject` (`note`, required), `GET /v1/expenses/{id}/receipt-url` (audited `expense.receipt_view` for anyone but the claimant); `GET /v1/admin/expenses?from` (admin, finance); approvals batch takes `type: "expense"` |
| Payroll adjustments (Pro) | `GET|POST /v1/admin/payroll-adjustments` (`user_id`, `kind`: bonus/deduction/reimbursement, `amount_cents`, `currency`, `note`, `recurrence`: once/every_period, `effective_from`, `effective_to?`; listing writes `payroll_adjustment.view` per person), `POST /v1/admin/payroll-adjustments/{id}/end` (`effective_to`; `409 not_recurring`), `DELETE /v1/admin/payroll-adjustments/{id}`; `GET /v1/me/payroll-adjustments` |
| Client portal (F9, Pro) | Agency (admin, finance): `GET|POST /v1/admin/clients/{id}/contacts` (`email`, `display_name`; the contact is emailed a sign-in link), `POST /v1/admin/client-contacts/{id}/send-link`, `POST /v1/admin/client-contacts/{id}/revoke`, `PUT /v1/admin/clients/{id}/portal` (`show_people`). Public: `POST /v1/client-portal/auth/login`, `GET|POST /v1/client-portal/auth/link` (`token`, `password`). Contact (cookie `rd_client`): `GET /v1/client-portal/me`, `GET /v1/client-portal/report?from&to&tz` → `ClientPortalReport` (audits `client_portal.view_hours` per person shown), `GET /v1/client-portal/invoices`, `GET /v1/client-portal/invoices/{id}` (issued and void only), `POST /v1/client-portal/auth/logout` |
| Logo (G26) | `GET /v1/admin/branding`, `POST /v1/admin/branding/logo-uploads` (`content_type` PNG/JPEG/WebP, `size_bytes` ≤ 512 KB) → presigned PUT, `PUT /v1/admin/branding/logo` (`upload_id`), `DELETE /v1/admin/branding/logo`; `Me.organization.logo_url`, `ClientPortalMe.organization.logo_url` and `InvoiceDTO.organization_logo_url` are short-lived links |
| MDM deployment (G26, Pro) | `GET\|POST /v1/admin/deployment-keys` (`name`; the key is returned once with `server_url`), `POST /v1/admin/deployment-keys/{id}/revoke`; public `POST /v1/devices/enrollment-requests` (`deployment_key`, `email`) → `202` always for a valid key (`401 invalid_deployment_key` otherwise); the person is emailed an ordinary enrolment code |
| Work-app presets (F9) | `POST /v1/admin/app-categories/presets` (`preset`, `category`, `team_id?`, `identifiers?`) → `{applied}` |
| Single sign-on | Public: `POST /v1/auth/sso/discover` (`email`) → `SsoDiscoverResponse`, `POST /v1/auth/sso/start` (`email`, `return_to?`) → `{redirect_url}`, `GET /v1/auth/sso/callback`. Org admin: `GET /v1/admin/sso` → `SsoSettings`, `PUT|DELETE /v1/admin/sso/connection`, `PATCH /v1/admin/sso` (`active`, `enforced`, `jit_provisioning`), `POST /v1/admin/sso/test`, `POST /v1/admin/sso/domains`, `POST …/domains/{id}/verify`, `DELETE …/domains/{id}`, `POST /v1/admin/scim-tokens`, `DELETE /v1/admin/scim-tokens/{id}`. Login with a password returns `403 sso_required` when single sign-on is required |
| Directory (SCIM 2.0) | `Authorization: Bearer rdscim_…`: `GET /scim/v2/ServiceProviderConfig|ResourceTypes|Schemas`, `GET|POST /scim/v2/Users` (`filter=userName eq "…"`), `GET|PUT|PATCH|DELETE /scim/v2/Users/{id}`, `GET|POST /scim/v2/Groups`, `GET|PUT|PATCH|DELETE /scim/v2/Groups/{id}`; RFC 7644 errors |
| Support access | Operator: `POST /platform/v1/organizations/{id}/support-grants`, `POST /platform/v1/support-grants/{id}/end`, `GET /platform/v1/organizations/{id}/support/{people,teams,devices,policies,audit}` (active grant only, audited). Tenant: `GET /v1/admin/support-grants`, `POST …/{id}/approve|deny|end` (org admin) |
| Audit | `GET /v1/audit-events?from&to&action&actor_id&subject_id&cursor` → `Page<AuditEventDTO>`; `GET /v1/audit-events/export` (CSV, up to 10,000 rows, audited); `GET /v1/audit-events/people` (auditor, org admin) |

Error codes the UI must handle: `unauthenticated` (401), `mfa_required` (403),
`forbidden` (403), `not_found` (404), `validation_failed` (400),
`expansion_requires_confirmation` (409), `seat_limit_reached` (409),
`plan_upgrade_required` (402), `subscription_inactive` (403).

## 6. Key flows

### 6.1 Device enrollment (`IAM-04`)

1. Admin creates an enrollment code for a user: 10 characters from an unambiguous
   alphabet, valid 30 minutes, single use; only its hash is stored.
2. Employee enters it in the agent. `POST /v1/devices/enroll` marks the code used in the
   same transaction that creates the device and returns the credential **once**.
3. Agent stores the credential in the OS keychain (Windows Credential Manager / macOS
   Keychain) and pins the policy signing public key.

### 6.2 Work session lifecycle (`TIME-01..07`)

Agent state machine (identical states server-side, minus `Suspended`):

```
             start(project?)                 pause                 stop
   Idle ───────────────────────► Active ◄──────────────► Paused ──────────► Stopped
                                   │  resume                                 ▲
                                   │ wall-clock jump > 2× tick (sleep/hibernate)
                                   ▼                                         │
                               Suspended ── wake: emit data_gap, resume ─────┘ (stop if
                                                                       policy/revoked)
```

* Capture (activity, apps, screenshots) runs **only** in `Active`. Every collector checks
  the state on each tick; stopping cancels pending captures and the next tick (≤ 1 s)
  produces nothing — well inside the five-second requirement.
* The tray/menu-bar indicator is visible in `Active` and `Paused`, and shows a camera
  badge when the resolved policy enables screenshots (`TIME-02`, `SCR-03`).
* Starting a session shows a notice listing what this session collects, generated from
  the resolved policy.

### 6.3 Activity aggregation (`ACT-01..06`)

The agent ticks once per second. On each tick it reads **counts** of input events since
the previous tick (keyboard, mouse) and the seconds since last input from the OS. A
second is *active* if any input occurred in it; *idle* once the time since last input
exceeds the resolved `idle.threshold_seconds` (the idle seconds are attributed back to the
start of the idle run, so a 5-minute threshold doesn't hide 5 minutes of idleness).
Seconds are folded into minute buckets aligned to UTC minutes.

```
activity % = Σ active_seconds / Σ (active_seconds + idle_seconds)
             over buckets with data_quality ∈ {ok, partial}
```

Paused time, suspended time, offline-agent-stopped time, and permission-missing minutes
are **not** in the denominator; they are shown as their own bands in the timeline
(`ACT-06`). Tracked time = Σ (active + idle) seconds, so a laptop asleep for two hours
contributes zero tracked seconds no matter what the wall clock says.

### 6.4 Policy model and resolution (`POL-01..05`) — [ADR-0003](../adr/0003-policy-resolution.md)

Policies are **partial** settings documents attached to a scope: `organization`, `team`,
`project`, or `device`. Each publish creates an immutable `policy_versions` row and bumps
the organization's `policy_revision` (a single integer — the `policy_version` in every
event envelope).

For a device + optional project, the applicable scopes are: the organization, every team
the user currently belongs to, the project, and the device. Each field resolves by its
declared strategy:

| Field | Default | Strategy |
|---|---|---|
| `session.allow_overlapping_sessions` | `false` | restrictive boolean |
| `session.require_project` | `false` | any `true` wins (stricter record keeping, not more collection) |
| `idle.threshold_seconds` (60–1800) | `300` | most specific scope that sets it |
| `apps.capture_app_name` | `true` | restrictive boolean |
| `apps.capture_domains` | `false` | restrictive boolean |
| `apps.capture_window_titles` | `false` | restrictive boolean (reserved; agent does not implement it in MVP) |
| `screenshots.enabled` | `false` | restrictive boolean |
| `screenshots.interval_minutes` (10–60) | `15` | maximum (least frequent) |
| `screenshots.primary_monitor_only` | `true` | any `true` wins |
| `screenshots.max_width_px` (640–1920) | `1280` | minimum |
| `screenshots.excluded_apps` | `[]` | union |
| `screenshots.employee_deletion` | `"self_service"` | `"self_service"` wins over `"review"` |
| `viewers.manager_can_view_activity` | `true` | restrictive boolean |
| `viewers.manager_can_view_apps` | `true` | restrictive boolean |
| `viewers.manager_can_view_screenshots` | `false` | restrictive boolean |
| `work_hours` | `null` (no limit) | most specific non-null; capture pauses outside the window |
| `retention.screenshot_days` (1–90) | `30` | minimum |
| `retention.activity_days` (7–365) | `90` | minimum |
| `retention.app_usage_days` (7–365) | `90` | minimum |
| `offline.max_screenshot_buffer_mb` | `50` | minimum |
| `offline.metadata_buffer_days` | `7` | most specific |

**Restrictive boolean:** if any applicable scope explicitly sets `false`, the result is
`false`; otherwise if any sets `true`, `true`; otherwise the default. So a feature that is
off by default (screenshots) must be explicitly turned on somewhere, and any scope can
veto it — "most privacy-restrictive wins on conflict" without forcing admins to enable
screenshots organization-wide just to use them on one project.

**Expansion check (`POL-05`).** Publishing compares the effective policy of every
affected employee before and after. If any employee would have *more* collected (a
boolean turns on, interval shortens, retention lengthens, a viewer is added), the API
returns `409 expansion_requires_confirmation` with the affected count unless the request
carries `confirm_expansion: true`; on confirmation, affected employees get a notification
and the version is flagged `expands_collection` in the audit trail.

**Signed delivery (`POL-04`).** `GET /v1/device/policy` returns
`payload_b64` = base64 of the exact UTF-8 JSON bytes of
`{organization_id, user_id, device_id, project_id, revision, issued_at, settings}`,
signed with Ed25519. The agent verifies the bytes before parsing, caches the last valid
document per project, and on any failure keeps the last good one. With no cached policy
for a project, the agent uses its cached base policy with `screenshots.enabled = false`.
Agents record which revision they applied (`policy_receipts`) via heartbeat (`POL-03`).

### 6.5 Screenshots (`SCR-01..11`)

```
Agent                              API                               Object storage
 │ local policy says enabled,        │                                      │
 │ session Active, random time due   │                                      │
 ├─ POST upload-intents ────────────►│ check: device active, user active,   │
 │                                   │ session active & not paused,         │
 │                                   │ resolved policy enabled, no excluded │
 │                                   │ app focused (agent-side)             │
 │◄── {screenshot_id, upload_url} ───┤ insert screenshots(status=pending,   │
 │    (PUT, 5 min, one key)          │ retention_after = now + days)        │
 │ capture → downscale → WebP        │                                      │
 ├─ PUT bytes ─────────────────────────────────────────────────────────────►│
 ├─ POST complete {sha256, bytes} ──►│ session still active at captured_at? │
 │                                   │ else delete object + mark deleted    │
 │                                   ├─ enqueue screenshot.verify ─► worker: HEAD/GET, hash,
 │                                   │                                 status=stored|failed
 Viewer ─ GET /screenshots/{id}/view-url ─► authz (self / manager if policy) → audit
                                          → presigned GET, 60 s
```

* Capture times are uniformly random within each interval (`SCR-04`), never more than
  one per interval, never while paused/suspended/offline. **Screenshots are not captured
  offline** — there is no upload intent to authorize them; this removes the hardest
  privacy edge case from the outbox.
* Excluded apps: if the foreground app is on `excluded_apps` at capture time, skip.
* Bytes never pass through the API process, logs, or analytics (`SCR-11`).
* Employee deletion (`SCR-09/10`): with `employee_deletion = self_service` and no legal
  hold, the request is approved automatically and the worker deletes the object and
  marks the row; otherwise an org admin reviews it. The audit entry records the
  screenshot id and outcome, never the image.

### 6.6 Corrections and manual time (`TIME-08`)

Employees can propose (a) a new manual time entry or (b) an edit to an existing session's
start/end/project. A correction stores `original` (snapshot of the session, or `null` for a
new entry), `requested`, and a mandatory `reason`. Team managers of the employee approve or
reject; approval applies `requested` to the session (or creates a `source = 'manual'`
session) without touching `original`. Reports show manual and corrected time distinctly.

### 6.7 Retention (`AUD-03/04`)

A scheduled `retention.run` job (hourly) deletes in this order, each step batched:

1. Screenshots with `retention_after < now()` and no matching legal hold → delete the
   object, then set `deleted_at`. The metadata row stays (without any image) so audit
   entries still resolve.
2. `activity_buckets` and `app_usage` older than the employee's resolved retention.
3. Processed `ingest_events` older than 14 days (raw envelopes are operational, not records).
4. Expired export files.

Sessions (time records) are retained under the organization's time-record class, not the
activity class. Legal holds are scoped to a user and a time range and must name a reason;
creating or releasing one is audited.

### 6.8 Exports (`RPT-04`)

`POST /v1/exports` checks scope with the same authz as the matching report, writes the
audit entry, and enqueues `export.generate`. The worker writes the CSV to `exports/…` in
object storage. Every cell beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with
`'` (CSV-injection guard). Downloads use a presigned URL; files expire after 24 hours.

## 7. Time integrity (`TIME-06`)

* The server owns session boundaries: `started_at` is the device-reported `occurred_at`
  corrected by the device clock offset, clamped to `[received_at − buffer window, received_at]`.
* **Clock offset:** each batch carries `sent_at`; `offset = received_at − sent_at`. If
  `|offset| > 120 s`, the server shifts every `occurred_at` and `bucket_start` in the batch
  by the offset and marks the device `clock_skew_detected` in device health.
* Durations always come from the agent's **monotonic** clock (and therefore from bucket
  seconds), never from wall-clock subtraction. A wall-clock jump while the monotonic
  clock barely moved is a clock change (`data_gap` with `clock_change`); a monotonic jump
  bigger than expected (sleep on platforms whose monotonic clock includes suspend) is a
  suspend.
* A bucket outside its session's `[started_at, ended_at]` window is rejected.

## 8. Desktop agent design

```
rd-agent-core
├── state.rs        SessionMachine: Idle/Active/Paused/Suspended/Stopped, emits lifecycle events
├── activity.rs     ActivityAggregator: per-second samples → minute buckets, idle attribution
├── apps.rs         AppTracker: foreground samples → app_usage segments (flush on change / 5 min)
├── screenshot.rs   ScreenshotScheduler: randomized slot per interval, gated by state + policy
├── policy.rs       SignedPolicy verify (Ed25519) + typed settings + work-hours check
├── outbox.rs       SQLite outbox, payloads sealed with ChaCha20-Poly1305 (key from OS keychain)
├── sync.rs         Batching (≤500 events), oldest-first, exponential backoff with jitter
├── clock.rs        Clock trait (wall + monotonic) — injectable for tests
└── platform.rs     traits: InputCounter, ForegroundApp, ScreenCapturer, CredentialStore
rd-agent            binary: enroll, run (headless), status; wires real or simulated platform
```

* **Platform layer.** Windows: `GetLastInputInfo` + low-level hooks that increment
  counters and discard the event immediately; `GetForegroundWindow` → process image name.
  macOS: `CGEventSourceCounterForEventType`-style counters and
  `NSWorkspace.frontmostApplication` → bundle id; screen capture via ScreenCaptureKit,
  which requires the Screen Recording permission. Missing permissions are reported in the
  heartbeat and produce `permission_missing` buckets — never repeated prompts (`DEV-03`).
* **Outbox.** Every event is written to the outbox before it is considered emitted. A
  flush sends the oldest 500 events; on `accepted`/`duplicate` they are deleted; on
  `rejected` they are deleted and logged locally by reason. Network errors back off
  1 s → 2 s → … → 5 min with jitter. Storage cap: 7 days of metadata by default; when the
  cap is hit, the oldest **activity/app** events are dropped first and lifecycle events are
  always kept.
* **Revocation.** `401 device_revoked` stops the session (`session.stopped.v1` with
  `revoked` is not sent — the server already knows), wipes the credential and outbox, and
  shows a notice.
* **Resource budget.** One 1-second tick loop on a single thread; no polling faster than
  1 Hz; target < 2 % CPU, < 150 MB RAM (`§12`).

## 9. Security

* TLS everywhere; HSTS on the web app. Cookies `HttpOnly; Secure; SameSite=Strict`.
* Passwords hashed with scrypt (N=2¹⁵, r=8, p=1); TOTP secrets encrypted with
  AES-256-GCM under an application key from the secret manager.
* Opaque tokens (user sessions, device credentials, enrollment codes) are stored as
  SHA-256 hashes only.
* Object storage: private bucket, public access blocked, SSE-KMS, lifecycle rule as a
  backstop to the retention worker. Presigned URLs are single-object and short-lived.
* Logs: request logging redacts `authorization`, `cookie`, `set-cookie`; ingestion and
  screenshot routes never log bodies; validation errors never echo payload values.
* Login rate-limited per IP and per account.
* Policy signing key: Ed25519, from the secret manager; `key_id` allows rotation.
* **Row-level security** (migration 003, ADR-0004): every tenant table has a FORCE'd policy
  keyed on `rd.org_id`. The API's pool sets it per connection from an AsyncLocalStorage
  scope: the authenticated user's or device's organization for tenant requests; `'*'`
  (system) only for public routes (login, enrollment, signup, webhooks), platform routes and
  the worker loop; tenant jobs run scoped to their organization. An unset scope sees
  nothing. The app must connect as a non-superuser role without `BYPASSRLS`; the
  integration tests run as such a role.

## 10. Testing strategy

| Layer | What we test |
|---|---|
| Contracts | Schema strictness (unknown fields rejected), policy resolution table above, expansion detection. |
| API (integration, real Postgres) | Tenant isolation on every read route; manager vs admin vs auditor screenshot access; ingestion idempotency (same batch twice → no new rows); overlap rejection; sleep gap → zero tracked time; stop → screenshot intent refused; retention deletes expired objects; export CSV injection guard; audit table rejects UPDATE/DELETE. |
| Agent core (unit) | State machine transitions; no samples outside Active; idle attribution; minute alignment; suspend detection; outbox replay ordering; signature verification failures keep last good policy; screenshot slots never during pause. |
| End-to-end (CI) | Agent binary in simulated mode enrolls against a running API, runs a session, syncs, and the report endpoint reconciles with the simulated input. |

## 11. Delivery plan for this repository

**Increment 1 (this change):** design, contracts, API (auth/MFA, org admin, enrollment,
devices, policy, sessions, ingestion, activity, screenshots, corrections, reports,
exports, retention, audit), worker, web dashboards (employee, manager, admin), agent core
with simulated platform, CI.

**Next increments:** native Windows/macOS collectors and the Tauri UI shell; signed
installers and staged auto-update (`DEV-02`); SSO/SCIM (`IAM-06`, done in slice 6); app/domain categories
(`ACT-07`); scheduled reports and PDF (`RPT-06`); aggregate-only executive views with
minimum group size (`RPT-07`); SQS adapter if/when the Postgres queue is outgrown;
Terraform for AWS (ECS/Fargate, RDS, S3, KMS).

## 12. Open decisions (from requirements §19, still owned by RoundDigital)

Jurisdictions and consultation duties; the top two business outcomes; which roles
genuinely need screenshots and who may view them; retention periods; identity provider
and cloud region; Windows/macOS version matrix. The design keeps all of these as
configuration (policy, retention, region) rather than code.
