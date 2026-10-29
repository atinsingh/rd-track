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
| G2 | Operator | Support grants: no request, approval, expiry or tenant-side audit — **done** | M | P0 |
| G3 | All | No forgot / reset password | S | P0 |
| G4 | Admin | No invite flow; admins hand over a one-time password, never forced to change | M | P0 |
| G5 | Admin | Mandatory admin MFA with no recovery codes and no admin reset | S | P0 |
| G6 | Admin | No trial-ending / payment-failed / grace / inactive emails | S | P0 |
| G7 | All | No notification bell or unread count; pages promise notifications that never come | M | P0 |
| G8 | Emp / Mgr | No notification for corrections, timesheet submitted, deletion decided, device revoked or permission denied | S each | P0 |
| G9 | Admin | Corrections from people with no manager never reached admins in the inbox — **fixed** | S | P0 |
| G10 | Admin / Emp | No agent download in the web app; unsigned installers; updater placeholder; no autostart — **done**: download, updates from the enrolled server with an admin policy, open at login; signing runs as soon as the certificates are added | M | P0 |
| G11 | Buyer | No terms / DPA acceptance at signup | S | P0 |
| G12 | Admin | Enrolment codes admin-only, one per person; no deep link; no self-enrolment — **done** | M | P1 |
| G13 | Emp | No account settings page (name, time zone, password, email, notification preferences, MFA opt-in) | M | P1 |
| G14 | Admin | People page can't edit role / name / time zone, reactivate, search or import CSV — **done** | S/M | P1 |
| G15 | Admin | Teams, projects and tasks can't be renamed or archived; project members can't be removed — **done** | S | P1 |
| G16 | Admin | No setup checklist after signup — **done** | M | P1 |
| G17 | Admin | No tenant export, contract-end deletion or deletion certificate — **done** | M | P1 |
| G18 | Emp | Deletion requests cover screenshots only; no "download my data" — **done** | M | P1 |
| G19 | Manager | No timesheet due dates, reminders or escalation — **done** | M | P1 |
| G20 | Org admin | No organization-wide summary without being a manager — **done** | M | P1 |
| G21 | Finance | No finance role; Money needs full `org_admin` — **done** | M | P1 |
| G22 | Finance | Payroll export buried in Rates and budgets — **done** | S | P1 |
| G23 | Finance | Invoices have no paid state and no send-to-client — **done** | S/M | P1 |
| G24 | Auditor | Audit filter by raw UUID; no person filter; no CSV export; auditor lands on My day — **done** | S | P1 |
| G25 | Integrations | Webhooks cover 4 events — **15 events, done** | S | P1 |
| G26 | Admin | SSO / SCIM (P1) — **done**; MDM packages and tenant logo (P2) — **done** | L | P1/P2 |
| G27 | All | Hard-coded English; mixed date and money formats | M | P2 |
| G28 | Admin | Deletion requests outside the unified inbox — **done** | S | P2 |
| G29 | Eng | `notify.policy_expansion` job kind with no producer or handler — **gone**: policy changes notify through the notify service | S | P2 |

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

1. **Engine foundation and trust fixes** — **done 2026-10-29**. Domain events, the
   notify service with email templates, the bell and preferences, billing-lifecycle
   emails (G6–G8); terms acceptance at signup (G11).
2. **Identity on the engine** — **done 2026-10-29**. Invites (also removes the
   operator-visible password, G1), password reset, MFA recovery codes and admin MFA
   reset, account settings (G3–G5, G13).
3. **Work items and rules** — **done 2026-10-29**. The server-side inbox with reviewer
   fallback, deletion requests in it, employee to-dos, timesheet deadlines and escalation,
   device-health alerts, a larger webhook catalogue (G19, G25, G28).

   As built, work items are computed on read rather than stored as a projection: one
   `GET /v1/inbox/counts` drives the badge, `GET /v1/me/todos` feeds the To do card on
   My day, and both disappear the moment the underlying thing is done. The deadline rule
   (`timesheet_rules`, set under Admin › Work limits) runs hourly as `rules.run`: a
   reminder the working day before, an overdue notice at the deadline, and one digest per
   reviewer after the escalation delay. People with no tracked time that week are never
   chased, and nothing is ever submitted for them. Computers that haven't synced for three
   working days notify their owner first (`device.stale`). Webhooks now follow the domain
   events: corrections, timesheets and time off (submitted / approved / sent back),
   people invited or deactivated, computers removed, sessions and exports — ids and dates
   only.
4. **Role workspaces.** Role homes; admin checklist; agent download and self-enrolment;
   complete People and Teams pages; finance role and Money home; auditor tools;
   organization summary (G10, G12, G14–G16, G20–G24).

   **4a done 2026-10-29**: `/` opens the person's home (Setup and health for org admins,
   Period close for finance, the audit log for auditors, Team today for managers, My day
   for anyone who tracks), with a view switcher in the rail that remembers the choice.
   The `finance` role (migration 012) runs Money without admin; Period close shows this
   month's approved hours, payroll export, invoices to finish, time not yet invoiced and
   budgets near their limit. Issued invoices can be emailed to the client and marked paid
   (amounts stay locked). Setup and health builds its checklist from the data and shows
   seats, reviewers, computers to check and hours by team (teams of 5+ only). Auditors
   filter by who acted or whose data it was and download CSV.

   **4b done 2026-10-29**: People can be searched and filtered (active, invited,
   deactivated), edited (name, role, time zone; nobody changes their own role and the last
   admin stays one) and reactivated. A CSV import checks every row with a dry run (same
   rules as one invite: email, role, seats, duplicates) before anyone is emailed, then
   invites row by row, creating teams by name. Teams can be renamed and archived once
   empty (creating one with the same name brings it back; migration 013); projects can
   be renamed, re-referenced, archived and restored; tasks renamed or archived; project
   members removed.

   **4c done 2026-10-29**: My computers lets anyone who tracks download the installer
   for their system (`AGENT_DOWNLOAD_BASE_URL` and `AGENT_VERSION`), get their own
   one-time connection code and open the app with an `rdtrack://enroll` link that fills in
   the server and code; they still press Connect. It lists their computers and their
   status. "Connect your computer" is a to-do until one is connected; admins can copy the
   same link from their code dialog. Still open from G10: code-signing certificates,
   the updater endpoint and key, and start-at-login (all need credentials or a release
   channel decision).
5. **Platform console and data lifecycle.** The operator console (`/platform`) with
   support grants end to end, tenant offboarding with export and deletion certificate,
   employee data export and erasure (G2, G17, G18). Then SSO / SCIM (G26).

   **5a done 2026-10-29**: the operator console at `/platform` (its own sign-in, TOTP
   every time) lists organizations by state with health counts only (people, connected
   computers, agent versions, last sync), creates organizations (the first admin is
   invited) and edits plans and seats. Support access (migration 014): an operator asks
   with a reason and up to 72 hours; the organization's admins are notified (security,
   can't be muted) and approve or decline under Settings › Support access; approval
   starts the clock, and either side can end it. While open, the operator can read
   people, teams, computers, policies and the audit log — never activity, apps,
   screenshots, time or money — and each section they open is written to the
   organization's audit log as “RoundDigital support · name”.

   **5b done 2026-10-29**: Settings › Organization data exports everything an admin can
   see as one ZIP of CSVs (people, structure, sessions, corrections, timesheets, time off,
   shifts, money, policies and history, computers without credentials, legal holds,
   support access, the full audit log) — never activity, app names, screenshots or
   secrets — downloadable for 24 hours. Closing needs the exact organization name, gives
   30 days in which any admin can cancel, and tells admins (security) and everyone else
   (privacy, so they can take their own data). On the day, an hourly job deletes the
   stored files and every row (one cascade from `organizations`, audit log included via
   its purge flag), then keeps a certificate outside the tenant — what was deleted, how
   many records and files, when backups age out (35 days), SHA-256 of the text — and
   emails it to the admins. Operators see closing organizations and the certificates.
   Migration 015.

   **5c done 2026-10-29**: What's collected › Your data. Anyone can download everything
   Track holds about them as a ZIP (sessions, activity, app usage, screenshots with their
   images, corrections, timesheets, time off, shifts, computers, notifications and every
   audit entry about them, including who viewed their data). Anyone can ask for their
   data to be erased; another admin decides under Settings › Data requests (nobody
   decides their own, and declining needs a reason the person sees). Approval closes the
   account at once; a job then deletes activity, app usage, idle decisions, data gaps
   and screenshots outside any legal hold, plus notifications, sign-in tokens and their
   own exports, and replaces name and email with "Erased person". Hours, timesheets and
   pay stay under that name. The person is emailed what was erased and what a hold kept;
   erased accounts can't be reactivated. Migration 016.

   **6 done 2026-10-29 (G26, Pro)**: Settings › Single sign-on.
   - *Single sign-on* through any OpenID Connect provider (Entra ID, Google Workspace,
     Okta, OneLogin, JumpCloud): authorization code flow with PKCE, ID tokens verified
     against the provider's published keys (RS/PS/ES algorithms, issuer, audience,
     expiry, nonce) with Node's crypto only. A sign-in is single use, expires in ten
     minutes and only completes in the browser that started it. The connection stays a
     draft until an admin signs in through it as themselves; changing it makes it a
     draft again. The login page asks for the email first and offers the provider when
     the address uses one. "Require single sign-on" turns passwords off for everyone but
     org admins (password + authenticator code stays as the way back in). People are
     matched by the provider's subject, then by email within the organization. A
     sign-in through the provider counts as multi-factor (the provider's own MFA policy
     applies), so admins aren't asked for Track's authenticator code on top.
   - *Domains* are verified with a DNS TXT record (`_rd-track.<domain>`); one
     organization per domain. With "Create accounts on first sign-in", someone at a
     verified domain joins as an employee with tracking off.
   - *Directory sync (SCIM 2.0)* at `/scim/v2` with bearer tokens an admin creates
     (shown once, revocable). Users are people (new ones are tracked while a seat is
     free and invited unless single sign-on is on); deleting or deactivating one
     deactivates them, never deletes, and the last admin can't be. Groups are teams
     (an existing team of the same name is claimed; managers keep their role). The
     directory's changes are audited as "Directory sync". Migration 017; the load
     balancer routes `/scim/*` to the API.
   - SAML 2.0 followed in slice 9; MDM packages and the tenant logo in slice 8.

   **7 done 2026-10-29 (G10)**: the desktop app updates from the server it is enrolled with
   (`GET /v1/device/update`, device credential, migration 023), a minute after start and
   then hourly. Each organization chooses under Admin › Devices › App updates: people
   choose when (default), automatically between sessions (never during one), or hold. The
   API builds the answer from the published release and its `.sig`; only bundles signed
   with the key built into the app install. *Open when I sign in to this computer* is in
   the app's Settings, off until the person turns it on. Code signing and notarization run
   in the release workflow as soon as the certificates and the updater key are added as
   secrets (agent/README.md); getting them is RoundDigital's to do.

   **8 done 2026-10-29 (G26 P2, G29)**:
   - *Logo* (every plan): an org admin uploads a PNG, JPEG or WebP up to 512 KB under
     Settings › Logo (presigned upload, private object, short-lived links; migration 024).
     It shows under the product mark in the menu (on a white chip so dark logos stay
     readable), in the client portal and on invoices. Replacing or removing it deletes the
     old object; closing the organization deletes it with everything else.
   - *Deploy with MDM* (Pro, `mdm`): Admin › Devices creates deployment keys (shown once,
     revocable, last used) and the files IT pushes with the app: `deployment.json`, a macOS
     script and a Windows PowerShell script that installs the MSI quietly. The app reads the
     file from `/Library/Application Support/RoundDigital Track/` or
     `%ProgramData%\RoundDigital Track\` and, until connected, asks for a work email; the
     server emails that person an ordinary one-time code (`POST /v1/devices/enrollment-requests`,
     the same answer whether or not the email exists, one code a minute per person). A key
     alone never connects a computer, and nothing is recorded until the person starts a
     session. "I have a code from my administrator" keeps the usual way.
   - G29 was already gone: policy changes notify people through the notify service.

   **9 done 2026-10-29 (G26, Pro)**: single sign-on through a SAML 2.0 provider (AD FS,
   Entra ID, Okta, Google Workspace, OneLogin, JumpCloud…), next to OpenID Connect. An
   organization has one connection and picks the protocol; switching replaces the other's
   details (migration 025).
   - *Setting up*: the admin pastes the provider's metadata XML (or its entity ID,
     HTTP-Redirect sign-in URL and signing certificate by hand). Track shows its own entity
     ID, reply URL (ACS) and a metadata URL the provider can import. Each organization has
     its own: `/v1/auth/sso/saml/{org}` and `…/{org}/acs`. Test-before-turn-on, "Require
     single sign-on", verified domains and creating accounts on first sign-in work exactly
     as with OpenID Connect. A new provider or sign-in URL goes back to a draft; a new
     certificate alone doesn't, so a provider rolling its key can list both and nobody is
     locked out. The page warns 30 days before the last certificate expires.
   - *Signing in*: Track sends an unsigned AuthnRequest over HTTP-Redirect with the
     sign-in state as RelayState. The answer must be signed (the Response or its
     assertion) by one of the stored certificates, from the provider's entity ID, for
     Track's entity ID, in response to that very request, and recent. The provider posts
     it cross-site, so the browser cookie isn't sent: Track checks it, keeps the outcome
     with the sign-in state, and sends the browser to a same-site page that finishes the
     sign-in only in the browser that started it, once. A persistent name ID is bound to
     the person like an OpenID subject; a transient one isn't (they're matched by
     address). Sign-ins started from the provider's app list are turned away with an
     explanation, since nothing ties them to a browser; encrypted assertions aren't
     accepted (TLS protects the answer, and Track publishes no encryption key).
   - Libraries: `@node-saml/node-saml` (signature, audience, InResponseTo and time checks)
     and `@xmldom/xmldom` for metadata; no DTDs are read.

The remaining Stage 4 features (F5 API tokens, F6 expected hours, F7 expenses, F8 payroll
adjustments, F9 polish) slot in after slice 3, since expenses and tokens both depend on
work items and notifications.
