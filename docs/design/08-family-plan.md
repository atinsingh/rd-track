# 08: Family, transparent parental controls (research and plan)

Status: **proposal**. Nothing here is built. Sources:
- `replica/family/recon.md`: a Qustodio recon from public sources, each claim linked, with
  unverified points marked.
- `replica/family/brand.md`: the name, palette, logo brief and voice.

## 1. What we would build, and why it can be different

Parents want to manage their children's phones and computers: screen time, schedules, app and
website rules, location, and alerts. Qustodio is the reference product. It covers Windows, Mac,
Android, iOS, Chromebook and Kindle at $59.95 a year (5 devices) and $104.95 (unlimited). Its
users' complaints are consistent:
- children bypass or uninstall it;
- the iOS VPN breaks apps;
- setup is spread over four apps;
- rules don't enforce;
- phones lock up;
- children hate it (Kids App 1.4★ on Play, 2.2★ on iOS).

**Our angle: transparent parental control.** The child sees exactly what the parent sees. The
app is always visibly on, nothing is hidden, and no message is read. This is Track's own promise
("the employee sees everything the manager sees") applied to families. It also happens to be
what the law and the stores require:
- Google Play's stalkerware rules;
- the UK children's code, which asks for "a clear and obvious sign for the child";
- the anti-stalkerware coalition's definitions.

So the safe product and the differentiated product are the same product. We compete on
reliability, one-app setup and teen trust, not on reading more.

## 2. Hard limits from the platforms

| Platform | What's possible | What isn't |
|---|---|---|
| **iOS** | Apple's Screen Time framework (Family Controls, ManagedSettings, DeviceActivity): block apps, categories and websites; schedules and limits; adult-content web filter. Location through Core Location. | Raw per-app usage on our server: apps arrive as opaque tokens, and the report extension can't make network requests. Reading messages or calls. Consumer MDM or VPN filtering for a new entrant (App Review 5.4 and 5.5). **Needs Apple's Family Controls *distribution* entitlement, requested per app and per extension, with no published timeline.** |
| **Android** (Google Play) | Usage access (reports and limits); an accessibility service for reliable blocking (with disclosure, consent and a declaration form); a local VpnService DNS filter (parental control is a named use); background location and geofences (child safety is Google's own example). | SMS and call logs (no exception for parental apps). Hiding the app. A side-loaded APK for extra powers (against policy, and Android 13+ and 2026–27 developer verification make it worse). Android's enterprise device-management API (monitoring-only products are forbidden). Requires `isMonitoringTool=child_monitoring` plus a persistent notification with a unique icon. |
| **Windows / macOS** | Everything Track's Rust agent already does (foreground app, idle, limits, tray UI, browser extension), plus a lock screen, and later system-wide filtering (macOS NE filter, Windows WFP or DNS). | Nothing store-gated; signing certificates are still needed (the same G10 item as Track). |

## 3. Safeguards (product rules, not options)

1. **Always visible.**
   - Android: a persistent notification with our icon.
   - iOS: the app plus Screen Time's own system UI.
   - Desktop: the tray icon and a "monitoring is on" line.
   - No stealth mode, no hidden or renamed app.
2. **"What my parent can see"** is the child app's home screen, worded for the child's age.
   Every rule change shows up there.
3. **Minors only.**
   - Each child profile has a birth month and year, and profiles turning 18 end automatically
     (the parent and the child are told 30 days ahead).
   - The parent attests to being the legal guardian at signup.
   - On iOS the child must be in a Family Sharing child account.
4. **Teen mode:**
   - It applies at 13+, or 14+ in Québec.
   - It has fewer categories and no web-history detail, only categories.
   - Location sharing is two-way.
   - The teen can see and request changes to the rules.
5. **Never collected:** message or call content, keystrokes, screenshots or camera, contacts.
   Track's screenshot module stays off for family organizations, enforced in the policy
   resolver and not just hidden in the UI.
6. **Tamper means an alert, not a trap.** If a device stops checking in, or the app is removed or
   its permissions revoked, the parent and the child are told. We don't make the app hard to
   uninstall.
7. **Minimal data.**
   - Location points: 7 days. Usage: 30 days. Alerts: 90 days.
   - Hosted in Canada (ca-central-1).
   - No ads, no analytics SDK in the child apps.
   - A DPIA, plus COPPA 2025 security and retention documentation.
8. **Abuse path.** Reports of use against an adult (a partner, an employee) go to a support
   queue. Accounts can be closed. The terms forbid monitoring adults.

## 4. What carries over from Track

| Track piece | Family use |
|---|---|
| Organizations, roles, RLS, authz | A family is an organization (`organizations.kind = 'family'`). Parents are `org_admin`. A second parent is invited with the same invite flow. |
| Policy model and resolver (`packages/contracts/src/policy.ts`) | Family rules are a new `family` section. Scopes are organization → **child** → device, the same partial-document folding, versioned, signed and published to devices. |
| Devices, link requests (sign in to connect), updates | Child devices connect the same way: the parent signs in on the child's device and picks the child. Desktop updates are reused. |
| Ingestion, outbox, sync | Usage events and alerts from all clients; the agent outbox and batching already exist in Rust. |
| Insights, retention, exports, erasure | Daily and weekly reports per child; the 30-day retention job; "download everything about me" for the teen. |
| Privacy module and "Who viewed your data" | The child-visible view and the audit of parent views (a differentiator no competitor has). |
| Notify, email, i18n EN/FR | Alerts (limit reached, asked for more time, left a place, device stopped checking in), the weekly email digest, and the full French Québec needs. |
| Billing (Stripe), signup | A per-family plan instead of per-seat, through the same Stripe setup. |
| Rust agent, browser extension | The whole Windows/macOS child client in a "family mode". |
| AWS Terraform | The same stack; Canadian residency claim. |

## 5. New pieces

**Data (migrations 030+):**
- `organizations.kind` (`business` | `family`).
- `child_profiles`: id, organization, display name, birth year and month, region (for 13 vs 14),
  teen mode, avatar colour.
- `devices.child_profile_id` (nullable) and `devices.platform` gains `android` and `ios`.
- `family_rules`: the policy scope rows with `scope_type = 'child'`.
- `usage_days`: per child, per device, per app-or-category, per day, in minutes. iOS sends only
  threshold events, not per-app minutes (see §2).
- `location_points` (7 days), `places` (geofences), `family_alerts`, and `time_requests` (asks
  for more time, with the answer).

**Rules (the `family` policy section):**
- a daily screen-time budget per weekday;
- routines: bedtime, school and homework, as schedules with an allow-list;
- per-app and per-category limits or blocks;
- web categories plus SafeSearch and YouTube Restricted;
- pause now (until a time);
- location sharing on or off, and places with arrive/leave alerts;
- whether asking for more time is allowed.

**API:**
- `/v1/family/children` (list, create, edit).
- `/v1/family/children/:id` with `/rules`, `/today`, `/week`, `/locations` and `/requests`.
- `/v1/family/places`.
- `/v1/device/family-rules` returns the signed rules, like `/v1/device/policy`.
- `/v1/device/usage`, `/v1/device/location` and `/v1/device/requests` take events from child
  devices.
- Device heartbeats carry permission state (usage access, accessibility, VPN, location,
  notifications), so revoked permissions become alerts.

**Clients:**
- **Parent:** the existing Next.js web app, responsive and installable as a PWA, with a family
  shell (Today, each child, Rules, Places, Alerts, Settings). No native parent app in the first
  release, except that the iOS parent view of per-app usage *must* be native (§2). It can come in
  phase 3, as part of the iOS app in a parent mode.
- **Child, Windows/macOS:** the Tauri app in family mode. A tray UI with time left, routines and
  "ask for more"; a full-screen lock when time is up; browser extension filtering.
- **Child, Android:** a native Kotlin app. A foreground service, usage stats, an accessibility
  blocker and overlay, a VpnService DNS filter, location, and FCM for "rules changed" pushes.
- **Child, iOS:** a native Swift app with Family Controls authorization (`.child`), ManagedSettings
  shields, DeviceActivity monitor and report extensions, Core Location, and APNs.

**Web filtering:**
- **Categories:** start with a family DNS resolver for adult, malware and phishing (for example
  Cloudflare's 1.1.1.3 family resolver or a hosted DNS-filtering service) plus our own allow and
  block lists. License a URL-category database before promising fine-grained categories;
  over-blocking is complaint #6.
- **On each platform:**
  - Android: local VPN, DNS only. No full-traffic tunnel, which keeps battery and app breakage
    down (complaint #2).
  - iOS: ManagedSettings web content.
  - Desktop: the extension first, a system filter later.

## 6. Phases

| Phase | What ships | Gate | Size (2–3 engineers) |
|---|---|---|---|
| **0. Day 1 paperwork** | Apple Developer account as an organization (D-U-N-S) and the **Family Controls distribution entitlement request** for the app and its 3–4 extensions; Google Play organization account and verification; a trademark search by counsel (`brand.md`); privacy counsel on COPPA, Québec Law 25 and Criminal Code s. 184; the DPIA started. | Starts now, runs in parallel | 1 week of someone's time, then waiting |
| **1. Family backend and parent web** | `organizations.kind`, child profiles, family rules in the policy resolver (screenshots forced off), child-aware link requests, alerts through notify, the weekly digest, the family shell on the web, the family plan in Stripe, EN/FR | none | 4–5 weeks |
| **2. Windows and macOS child** | The Tauri app in family mode: usage, budgets and routines with a lock screen, ask for more, browser-extension filtering and SafeSearch, a tamper heartbeat, the "what my parent can see" screen | code-signing certs (shared with Track G10) | 3–4 weeks |
| **3. Android child (Play)** | Usage and limits, the accessibility blocker with disclosure, the DNS VPN filter, location and places, FCM, `child_monitoring` flag and persistent notification, teen mode | Play declarations: accessibility, VPN, background location; expect review loops | 8–10 weeks |
| **4. iOS child and parent** | Family Controls (`.child`), shields, schedules and limits, the adult web filter, location, the native parent report view | **The Apple entitlement**; without it there is no TestFlight | 8–10 weeks after approval |
| Later | SOS button, Chromebook (the Android build), Kindle, YouTube history (Android only), on-device AI alert *categories* (never transcripts), a router or DNS product | | |

Phases 1 and 2 give a sellable "family computers" product in about two months, while the store
gates run. Android follows. iOS lands when Apple says yes.

## 7. Pricing sketch (to test, not decided)

| Plan | Price | What |
|---|---|---|
| Free | $0 | 1 child, 1 computer, daily budget and routines |
| Family | $49 a year | up to 5 children, unlimited devices, all rules, web filtering, digest |
| Family + location | $79 a year | adds location, places and alerts |

This undercuts Qustodio's Basic ($59.95) and Complete ($104.95). Their price for calls and
messages has no equivalent here, by design. Billing is in CAD and USD.

## 8. Risks, ranked

1. **The Apple entitlement**: no timeline and no guarantee. We mitigate by filing on day 1 and
   sequencing iOS last.
2. **Google Play review**: three declarations plus monitoring-tool compliance. We mitigate by
   keeping permissions minimal, writing disclosures before code, and recording the videos early.
3. **Enforcement reliability**: OEM background killers, battery, time changes, offline use. We
   mitigate with a device test lab (Samsung, Pixel, Xiaomi), local enforcement that works
   offline, and battery budgets in CI.
4. **Web filter quality**: we mitigate by being DNS-first, licensing categories later, and making
   "ask to unblock" one tap for the child.
5. **Brand bleed onto Track**: we mitigate with a separate product name (`brand.md`), separate
   store listings, and family organizations that can never turn on employee features.
6. **Legal**: COPPA documentation, Québec's under-14 consent, a DPIA for the UK and EU. Counsel
   in phase 0.

## 9. Decisions needed from RoundDigital

- **Name:** Openkin (pending checks), RoundDigital Family, or another.
- **Market order:** Canada and the US first (recommended), then the UK and EU after the DPIA.
- **Location:** in the paid tier only, or in every plan.
- **First-release parent app:** the web app as a PWA (recommended), or native from the start.
- **Web categories:** start DNS-only (recommended), or license a category database for launch.
- **Team:** Android and iOS each need a native engineer; Kotlin and Swift are not in the
  codebase today.
