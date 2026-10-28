# RoundDigital Track — desktop agent

A Cargo workspace with the platform-independent agent core, the native collectors and
headless CLI, and the tray app employees install (Windows MSI/EXE, macOS DMG).
Design: [`docs/design/01-system-design.md`](../docs/design/01-system-design.md) §5–§8,
agent UI: [`docs/design/02-ux-design.md`](../docs/design/02-ux-design.md) §4.

```
agent/
├── Cargo.toml                 workspace (shared dependency versions, lints)
├── clippy.toml
└── crates/
    ├── rd-agent-core/         library: all agent logic, fully unit-tested
    │   └── src/
    │       ├── state.rs       SessionMachine: Idle/Active/Paused/Suspended/Stopped
    │       ├── activity.rs    per-second samples → UTC-minute buckets, idle attribution
    │       ├── apps.rs        foreground samples → app_usage segments
    │       ├── screenshot.rs  random slot per interval, capture gates, capture pipeline
    │       ├── policy.rs      Ed25519 signed policy, typed settings, work hours, cache
    │       ├── outbox.rs      SQLite outbox sealed with ChaCha20-Poly1305, sequence counter
    │       ├── sync.rs        batching, per-event results, backoff, bisection
    │       ├── clock.rs       Clock trait (wall + monotonic), suspend / clock-change detection
    │       ├── platform.rs    InputCounter, ForegroundApp, ScreenCapturer, CredentialStore, HttpTransport
    │       ├── api.rs         wire types + client for every agent endpoint
    │       ├── events.rs      event envelope + strict payload types
    │       ├── identity.rs    persisted enrollment data
    │       ├── runtime.rs     Agent (tick logic) + Runtime (1 Hz loop, network thread,
    │       │                  LiveStatus observer for UIs)
    │       ├── describe.rs    "what this session collects" (same wording as the web)
    │       └── ts.rs          RFC 3339 UTC formatting
    ├── rd-agent/              library + binary: enroll / run / status
    │   └── src/
    │       ├── lib.rs         shared by the CLI and the tray app
    │       ├── main.rs        CLI (clap)
    │       ├── setup.rs       enrollment, opening the outbox, credential store choice
    │       ├── native/        native collectors behind cfg(target_os)
    │       │   ├── windows.rs low-level hooks (counts only), GetLastInputInfo, process image, GDI capture
    │       │   ├── macos.rs   CGEventSource counters/idle, NSWorkspace, CGDisplayCreateImage
    │       │   └── logic.rs   pure helpers unit-tested on every OS (counter wraparound, …)
    │       ├── http.rs        ureq + rustls transport, env proxies with NO_PROXY
    │       ├── credentials.rs 0600 file store (default) / OS keychain (feature `keychain`)
    │       ├── simulated.rs   seeded fake input, rotating fake apps, solid-colour screen
    │       └── config.rs      data directory layout, device.json
    └── rd-agent-desktop/      Tauri 2 tray app (see "Desktop app" below)
        ├── src/               main.rs (commands), controller.rs (runtime thread),
        │                      tray.rs, view.rs (pure view model, unit-tested)
        ├── ui/                popover: src/app.ts → public/app.js (committed), no framework
        ├── capabilities/      the web view's command allowlist
        ├── icons/             app + tray icons (idle / tracking / paused)
        ├── macos/             Info.plist (LSUIElement, usage text), entitlements
        └── tauri.conf.json    bundle (MSI, NSIS, DMG), identifier, updater
```

## Build and test

```sh
cd agent
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
cargo build --release -p rd-agent                 # target/release/rd-agent
cargo build --release -p rd-agent --features keychain
cargo build -p rd-agent-desktop                   # tray app (debug)
```

Requires a C compiler (SQLite is compiled in via `rusqlite/bundled`). MSRV 1.82 for the
core and CLI; the tray app needs Rust ≥ 1.85 and, on Linux, the WebKitGTK/tray
development packages:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
```

Because `rd-agent-desktop` is a workspace member, `cargo … --workspace` on Linux needs
those packages too. CI: [`.github/workflows/agent.yml`](../.github/workflows/agent.yml)
(clippy + tests on Ubuntu, Windows and macOS; installers on every push touching
`agent/**`, on `workflow_dispatch` and on `agent-v*` tags).

**Cross-checking from Linux.** `cargo check`/`clippy --target x86_64-pc-windows-msvc`
and `--target aarch64-apple-darwin` type-check every crate including the native modules
and the tray app, but the C build scripts (`ring`, bundled SQLite) need a C compiler for
the target. Without an MSVC/Apple SDK, point `CC_<target>`/`AR_<target>` at a stub that
writes empty objects — fine for `check`, which never links; never use it for builds.

## Using the binary

```sh
rd-agent enroll --server https://track.example.com --code ABCDEFGHJK [--device-name NAME] [--force]
rd-agent run [--simulate] [--project ID] [--task ID] [--seed N] [--duration SECS] [--stdin-control] [--no-auto-start]
rd-agent status [--json]
```

* `run` starts a session immediately (unless `--no-auto-start`) and tracks until Ctrl-C /
  SIGTERM (session stopped with reason `user`), or until `--duration` elapses. On exit it
  attempts a final sync for up to 10 s; anything left stays in the outbox for next time.
* `--stdin-control` accepts `start [project] [task]`, `pause`, `resume`, `stop`, `quit`.
* Without `--simulate` the native collectors are used (Windows, macOS); Linux has none
  and requires `--simulate`.
* Exit codes: `0` ok, `1` error, `3` device revoked (local data wiped), `4` tracking
  unavailable for licensing reasons (credential and outbox kept).
* Data directory: `--data-dir`, else `$RD_AGENT_DATA_DIR`, else
  `~/.local/share/rd-agent` (Linux, honouring `$XDG_DATA_HOME`),
  `~/Library/Application Support/RoundDigital Track` (macOS),
  `%APPDATA%\RoundDigital Track` (Windows). Contents: `device.json` (non-secret
  enrollment data, `0600`), `outbox.db` (encrypted outbox + signed-policy cache),
  `secrets/` (file credential store, dir `0700`, files `0600`).
* Logging: `RUST_LOG=debug rd-agent run …`. Logs contain event types and counts only —
  never payloads, credentials or presigned URLs.

CI end-to-end (design §10): enroll with a code from the API, then
`rd-agent run --simulate --project <id> --seed 1 --duration 120` and reconcile the report.
The simulated platform is deterministic per seed (seed `86` puts the first screenshot
slot within the first second when the project policy enables screenshots).

## How it works

* **One tick loop, one network thread.** `Runtime` ticks the `Agent` at 1 Hz on the
  calling thread. All HTTP (sync every 5 s, heartbeat every 60 s, policy every 5 min,
  screenshot uploads) runs on a worker thread, so a slow network can never stretch a tick
  (which would look like a suspend) or delay a stop. Commands arrive on a channel and are
  applied between ticks immediately — a stop takes effect in milliseconds.
* **Capture only in `Active`.** Collectors run only from `Active` ticks. Leaving `Active`
  removes input hooks (`InputCounter::set_capturing(false)`), flushes the last partial
  second, and closes every `CaptureGate`, which cancels any screenshot job that has not
  yet captured. After a stop, the next tick samples nothing.
* **Time comes from the monotonic clock** (one that includes suspend: `CLOCK_BOOTTIME` on
  Linux, `CLOCK_MONOTONIC` on macOS, QPC on Windows). A tick whose monotonic delta exceeds
  2× tick is a suspend → `data_gap.v1 {reason: suspended}` and no seconds for that span;
  a wall jump without a monotonic jump is `clock_change`.
* **Activity.** Each second is classified active / idle / pending / missing. When an
  inactive run reaches `idle.threshold_seconds`, the whole run becomes idle back to its
  first second; buckets holding pending seconds are held (≤ threshold) until the run
  resolves. A bucket is never emitted twice for the same minute (pause/resume within a
  minute continues the "parked" bucket; seconds that would land in an already-emitted
  minute after a backwards clock change are dropped).
* **Outbox.** Each envelope is sealed whole with ChaCha20-Poly1305 (AAD binds it to its
  `event_id`); the key is a 32-byte secret in the credential store. `sequence` is allocated
  in the same SQLite transaction as the insert. Over the cap (50 000 droppable events or
  `offline.metadata_buffer_days`), the oldest `activity_bucket`/`app_usage` events are
  dropped; `session.*` and `data_gap` events never are.
* **Crash recovery.** The open session is snapshotted every 10 s. On restart within 10
  minutes it is resumed with `data_gap {reason: offline_agent_stopped}`; otherwise it is
  closed with `session.stopped {reason: shutdown}` at the last time the agent was seen.
* **Revocation** (`401 device_revoked` anywhere, or heartbeat `credential_status:
  "revoked"`): stop locally without an event, wipe the outbox, delete the credential and
  outbox key, mark `device.json` revoked, exit 3.
* **Licensing** (`403 subscription_inactive` / `403 seat_unavailable` from any agent
  endpoint, including screenshot upload intents): soft stop. The open session is stopped
  with `session.stopped {reason: policy}` (queued; delivered later or rejected), all
  collection stops, new sessions are refused, the credential and outbox are kept. The
  network thread then sends nothing but a heartbeat at most every 15 minutes; the first
  2xx heartbeat clears the block (headless `run` then starts a new session). The block is
  persisted, so a restart does not start collecting either; the first heartbeat after a
  process start is sent immediately. The heartbeat `license {status, grace_ends_at?}` is
  parsed leniently and shown by `rd-agent status`.

## Privacy guarantees enforced in code

* `InputCounter` can only return counts and seconds-since-last-input; `ForegroundApp`
  only an identifier and a name. There is no API through which a key code, typed text,
  clipboard, window title or URL could reach the core.
* Payload structs are closed (`deny_unknown_fields`, no free-form maps). `domain` is never
  collected (always omitted); `apps.capture_app_name = false` disables app usage entirely;
  `apps.capture_window_titles` is ignored.
* Screenshots: only when the signed policy for the session's project enables them, only
  in `Active`, inside work hours, with no excluded app in front, and only after the server
  issued an upload intent — so never offline. Bytes go straight to the presigned URL (no
  device credential is sent there).
* Native collectors: the Windows hook procedures never dereference the event structure
  (no virtual-key or scan code is read), hooks exist only while `Active`; macOS uses
  aggregate HID counters, not an event tap. Foreground lookups return a process image /
  bundle id and display name — no API that returns a window title or URL is called.
  macOS capture refuses to run without Screen Recording rather than upload a
  wallpaper-only frame.
* Tray app: the session-start notice is generated from the verified policy with the
  web's wording; the web view cannot reach the network, filesystem or shell (command
  allowlist + CSP); permission prompts are shown at most once per install.

## Credential storage

Development and CI use `FileCredentialStore` (`secrets/`, `0600`). Production uses the OS
keychain: build with `--features keychain` (the `keyring` crate: Windows Credential
Manager, macOS Keychain, Linux kernel keyutils — the latter does not survive a reboot,
which is fine because Linux is a development target only). `RD_AGENT_CREDENTIAL_STORE=file`
forces the file store in a keychain build. The tray app always uses the keychain on
Windows and macOS (service `rd-agent:<data dir>`) and the file store on Linux.

## Native collectors

Implemented in `crates/rd-agent/src/native/` behind `cfg(target_os)`; the core needed no
new traits (only an optional `ScreenCapturer::capture_scaled` so the OS can scale while
capturing). "Compiles" = `cargo clippy -D warnings` passes for the target (cross-checked
from Linux and in CI on the real OS); "verified on hardware" = exercised by a person on a
real machine. **Nothing in this table has been verified on hardware yet** — CI runs the
unit tests on Windows and macOS runners but cannot generate real input or grant
permissions.

| | Windows (`windows-sys` 0.61) | macOS (`objc2-*` 0.3) | Linux |
|---|---|---|---|
| Input counts | `SetWindowsHookExW(WH_KEYBOARD_LL / WH_MOUSE_LL)` on a dedicated message-loop thread, installed on `set_capturing(true)` and removed on `false`. The hook procs read only `wParam` (message kind: key-down / any mouse message), bump an atomic and call `CallNextHookEx`; `lParam` (`KBDLLHOOKSTRUCT`, `MSLLHOOKSTRUCT`) is never dereferenced. | Deltas of `CGEventSourceCounterForEventType(HIDSystemState, …)` for key-down and mouse move/drag/button/scroll (wraparound-safe). No event tap. | simulated |
| Idle time | `GetLastInputInfo` vs `GetTickCount` (wraps every 49.7 days; handled) | `CGEventSourceSecondsSinceLastEventType(HIDSystemState, kCGAnyInputEventType)` | simulated |
| Foreground app | `GetForegroundWindow` → `GetWindowThreadProcessId` → `OpenProcess(QUERY_LIMITED)` → `QueryFullProcessImageNameW`. Identifier = exe file name (`Code.exe`), name = version-resource `FileDescription` (cached per path) or the exe stem. Window titles never read. | `NSWorkspace.sharedWorkspace.frontmostApplication` → `bundleIdentifier`, `localizedName`. The CLI ticks on the main thread and pumps the run loop for workspace notifications; the tray app's main thread runs it anyway. | simulated |
| Screen capture | GDI `StretchBlt` (HALFTONE) of the primary monitor straight into a DIB of `max_width_px` → BGRA→RGBA. Permission `not_required`. | `CGDisplayCreateImage(CGMainDisplayID())` drawn into an RGBA bitmap context of `max_width_px`. `CGPreflightScreenCaptureAccess()` before every capture (no permission → no capture, never the wallpaper-only image). | simulated |
| Permissions reported | all `not_required` | `screen_recording`: preflight result. `input_monitoring`: `granted` if `CGPreflightListenEventAccess`, `denied` if the counters were judged broken (below), else `not_required`. | simulated |
| Credential store | Windows Credential Manager (`keyring`) | Keychain (`keyring`) | file store (`0600`) in the tray app |
| Status | compiles · unit-tested pure logic · **not verified on hardware** | compiles · unit-tested pure logic · **not verified on hardware** | simulated, used by CI e2e |

**macOS Input Monitoring.** The counter approach needs no event tap, so we expect no
Input Monitoring prompt; Apple does not document whether `CGEventSourceCounterForEventType`
is gated on recent releases. The agent therefore self-checks: if the idle timer shows input
for 30 s while every counter stays flat, counts are reported unavailable (`partial` /
`permission_missing` buckets, `input_monitoring: denied` in the heartbeat) and the tray
offers the permission. **Verify on macOS 13/14/15 before the pilot.**

**Known gaps (follow-ups).** `primary_monitor_only = false` falls back to the primary
monitor on both OSes. `CGDisplayCreateImage` is deprecated (ScreenCaptureKit
`SCScreenshotManager`, macOS 14+, is the replacement; on macOS 15 the legacy API may show
the periodic "is capturing your screen" reminder). Windows DXGI Desktop Duplication would
be cheaper than GDI. The CLI process is not DPI-aware on Windows (it captures the scaled
desktop); the tray app is per-monitor DPI-aware through Tauri's manifest. The Windows
"secure desktop" (UAC, lock screen) yields no foreground app and a failed capture, which
is the intended outcome.

## Desktop app (`rd-agent-desktop`)

A Tauri 2 tray / menu-bar app embedding the same `Runtime` (native collectors; simulated
on Linux, or with `RD_AGENT_SIMULATE=1`). It matches the approved mockup (Agent.dc):

* **Popover** (dark, `#0B0C0F`): red tracking dot + `TRACKING` / `PAUSED` / `NOT TRACKING`
  and the session's active time `H:MM:SS`; camera badge "Screenshots on for this project ·
  about every N min" when the session's policy enables them; Project / Task pickers;
  Start (idle) or Pause|Resume / Stop; "Today 6h 42m · activity 71%" (this device, from
  emitted buckets); sync line ("Synced 12 s ago", "Offline · 3 queued"); "My dashboard →".
* **Session-start notice** (light): "Start a session on <project>?" listing what the
  session collects, generated from the project's *verified* policy with
  `rd_agent_core::describe::describe_collection` — a line-for-line port of
  `packages/contracts/src/describe.ts` (tests pin the strings). If the project's policy
  cannot be fetched within 4 s the notice says so (screenshots stay off until it arrives);
  if a later policy *expands* collection mid-session, a banner asks the employee to review.
* **Enrollment** screen (server URL + one-time code), **revocation** screen, and banners
  for licence refusal / grace, missing permissions ("Allow…" once, then "Fix in System
  Settings" — never a second prompt, `DEV-03`), work-hours pause, overlap stop, recovery.
* **Tray icon** states idle / tracking / paused, tooltip (and on macOS a title with the
  elapsed time). Left click toggles the popover; right click opens the menu (Open,
  Pause/resume, Stop, Quit). **Quit stops the session first** and waits for the bounded
  final sync. Closing the popover only hides it.
* **Security.** The web view gets no filesystem/shell/HTTP/opener permissions: only the
  17 app commands listed in `capabilities/main.json` (each an `allow-<command>`
  permission generated by `build.rs`) plus event listening. URLs are opened by Rust from a
  fixed allowlist (dashboard, System Settings panes). Strict CSP, no remote content, fonts
  (Inter, JetBrains Mono, OFL) and logos bundled. The device credential lives in the OS
  keychain (file store on Linux).
* **UI source** is `ui/src/app.ts` (TypeScript, no framework). The compiled
  `ui/public/app.js` is committed so `cargo build` needs no Node; rebuild with
  `npm --prefix agent/crates/rd-agent-desktop/ui run build` (CI fails if it is stale).

Run during development:

```sh
cd agent
cargo run -p rd-agent-desktop                      # data dir as for the CLI
RD_AGENT_DATA_DIR=/tmp/rd RD_AGENT_SIMULATE=1 cargo run -p rd-agent-desktop
RD_TRACK_DASHBOARD_URL=https://app.example.com/me cargo run -p rd-agent-desktop
```

"My dashboard" opens the `dashboard_url` the server returns at enrollment (falling back to
`<server>/me` for older servers); `RD_TRACK_DASHBOARD_URL` overrides both. The CLI and the tray app share the data directory layout; do not run both at once.

### Building installers

```sh
cd agent/crates/rd-agent-desktop
npx @tauri-apps/cli@2.12.4 build --bundles msi,nsis                                  # on Windows
npx @tauri-apps/cli@2.12.4 build --target universal-apple-darwin --bundles app,dmg   # on macOS
```

Output: `agent/target/[<target>/]release/bundle/{msi,nsis,dmg,macos}/`. Bundle identifier
`digital.round.track`, product name "RoundDigital Track", MSI upgrade code fixed in
`tauri.conf.json` (never change it — it is how upgrades find the installed product).
CI builds the same unsigned installers on every push touching `agent/**` and uploads them
as workflow artifacts; on `agent-v*` tags (version taken from the tag) they are also
attached to a draft GitHub release.

### Signing, notarization and updates — what you must provide

Without these the installers work but are unsigned: **Windows** SmartScreen shows "Windows
protected your PC" (More info → Run anyway) and IT tools may block the MSI; **macOS**
Gatekeeper refuses to open the app ("cannot be opened because the developer cannot be
verified"; right-click → Open, or `xattr -dr com.apple.quarantine`). Neither is acceptable
for the pilot. Store these as GitHub Actions **secrets** (S) / **variables** (V); each
signing step runs only when its secrets exist.

| Purpose | Name | What it is |
|---|---|---|
| macOS signing | `APPLE_CERTIFICATE` (S) | base64 of a **Developer ID Application** certificate + private key exported as `.p12` (Apple Developer Program, Account Holder creates it) |
| | `APPLE_CERTIFICATE_PASSWORD` (S) | the `.p12` password |
| | `APPLE_SIGNING_IDENTITY` (S) | e.g. `Developer ID Application: RoundDigital SIA (TEAMID1234)` |
| macOS notarization | `APPLE_ID` (S), `APPLE_PASSWORD` (S), `APPLE_TEAM_ID` (S) | Apple ID email, an **app-specific password** for it, and the 10-character team id. (An App Store Connect API key — `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` — also works with the Tauri bundler but is not wired into the workflow.) |
| Windows signing (certificate) | `WINDOWS_CERTIFICATE` (S), `WINDOWS_CERTIFICATE_PASSWORD` (S) | base64 `.pfx` of an **OV or EV Authenticode** code-signing certificate. Since 2023 CAs issue new OV/EV keys only on hardware tokens/HSMs, so an exportable PFX usually means a cloud HSM product; otherwise use Azure Trusted Signing |
| Windows signing (Azure Trusted Signing, recommended) | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` (S); `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` (V) | a service principal with the "Trusted Signing Certificate Profile Signer" role on an Azure Trusted Signing account + certificate profile (organization identity validation required) |
| Updater signatures | `TAURI_SIGNING_PRIVATE_KEY` (S), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (S) | generated once with `npx @tauri-apps/cli@2.12.4 signer generate -w ~/.tauri/rd-track.key` — keep the private key offline/backed up; losing it means installed agents can never update again |
| | `TAURI_UPDATER_PUBKEY` (V) | the matching public key (contents of `rd-track.key.pub`); CI writes it into the updater config, replacing the placeholder in `tauri.conf.json` |
| | `TAURI_UPDATER_ENDPOINT` (V, optional) | real update endpoint; the committed placeholder is `https://updates.example.invalid/{{target}}/{{arch}}/{{current_version}}` |

No real keys are committed. The update endpoint must serve Tauri's static/dynamic update
JSON (`version`, `platforms.<target>-<arch>.{url, signature}`) — hosting it (e.g. S3 +
CloudFront next to the web app) is an infrastructure task. Debug builds and builds with
the placeholder key never install updates.

### First run on employee machines

* **macOS.** The DMG installs a menu-bar app (no Dock icon, `LSUIElement`). Requirements:
  macOS 12+. **Screen Recording** is needed only if the organization enables screenshots
  for a project: the tray shows a banner, "Allow…" triggers the system prompt **once per
  install** (`CGRequestScreenCaptureAccess`), after which the button opens System Settings
  → Privacy & Security → Screen Recording; macOS requires relaunching the app after
  granting. Until granted, no screenshots are taken (the heartbeat reports
  `screen_recording: denied`). **Input Monitoring** is not expected to be needed (see
  above); if the self-check finds the counters blocked, the same once-only flow is offered
  for Input Monitoring. **Accessibility** is not used. MDM can pre-grant Screen Recording
  only as "allow standard user to approve" (PPPC `ScreenCapture` cannot be silently
  granted); bundle id `digital.round.track`, team id from the Developer ID certificate.
* **Windows.** MSI (per-machine, for Intune/GPO) or NSIS `.exe`. No OS permission prompts:
  low-level hooks, `GetLastInputInfo` and GDI capture need none. Unsigned builds trigger
  SmartScreen; a signed build from a new certificate may still show it until the
  certificate builds reputation (EV and Azure Trusted Signing establish it fastest).
  Some EDR products flag processes that install low-level keyboard hooks — security teams
  may need to allow-list the signed binary.
* **Both.** The first window is the enrollment screen. Nothing is recorded until the
  employee starts a session and confirms the notice. Autostart at login is not configured
  yet (follow-up: Tauri autostart plugin, off by default, shown in the notice).

### Contract (API)

* `GET /v1/device/projects` → `{projects: [{id, name, tasks: [{id, name}]}]}`,
  device-authenticated: the active projects/tasks the device's user may book to (projects
  with members list only those members). On `404` (older servers) the tray offers
  "No project" only.
* `dashboard_url` in the enrollment and heartbeat responses.
* Still open, optional: a device-authenticated "today" total across all of the user's devices; the
  tray currently shows this device's buckets only.

## Wire notes for the API

* JSON is snake_case; timestamps are UTC with `Z` and at most millisecond precision
  (`2026-10-28T09:41:00Z`, `…:01.234Z`). Event ids, session ids and batch ids are UUIDv4.
* Optional payload fields (`project_id`, `task_id`, `domain`) are **omitted**, never `null`.
  `session.resumed.v1` sends `"payload": {}`.
* `bucket_start` is the floor of the UTC minute, so the first bucket can start up to 59 s
  before the session's `started_at` and the last can end after `ended_at`: validate
  overlap with the session window, not containment. A bucket's `occurred_at` is
  `min(bucket_start + 60 s, emission time)`.
* A bucket for the minute in which a session was paused may arrive after
  `session.paused.v1` (it only contains seconds from before the pause); all buckets of a
  session precede its `session.stopped.v1`.
* `data_gap.v1`: `suspended` gaps run from the last tick before sleep to the first after;
  `occurred_at` = `gap_end`. `clock_change` gaps cover the jumped span (`gap_start ≤
  gap_end` always).
* A recovered stale session's `session.stopped.v1` has `occurred_at` = last time the agent
  was seen, possibly hours before `received_at`.
* After an `overlapping_session` rejection the agent sends `session.stopped.v1 {reason:
  overlap}` for that session; expect to reject it `unknown_session`.
* Batch-level `400`/`413`/`422` responses are bisected; a single event that still fails is
  dropped and recorded locally with the error code. Events missing from `results`, or
  with an unknown status, are retried. Unknown heartbeat/response fields are ignored.
* Policy: base document via `GET /v1/device/policy` (no query), project via
  `?project_id=`. `payload_b64`/`signature_b64` are standard base64 (URL-safe and unpadded
  are accepted). The payload must carry this device's `organization_id`/`device_id` and
  the requested `project_id` (`null` for base); a lower `revision` than cached is refused.
  `key_id` must equal the key pinned at enrollment (rotation needs re-enrollment for now).
  Unknown settings are ignored, missing ones take the §6.4 defaults, numbers are clamped.
* `work_hours` (not specified in the design) is parsed as
  `{"timezone": "Europe/Riga", "days": [1,2,3,4,5], "start": "09:00", "end": "18:00"}` —
  IANA zone, ISO weekdays (or `"mon"`…), local `HH:MM`, `end ≤ start` = overnight, empty
  `days` = every day. An unparseable window rejects the whole document (last good kept).
* Screenshots are uploaded as `image/jpeg` (quality 70); `complete.sha256` is lowercase
  hex of the uploaded bytes; `width`/`height` are after downscaling.
* Heartbeat `credential_status: "revoked"` is treated like `401 device_revoked`.

## Deviations from the design

* Network I/O runs on a second thread (the 1 Hz tick loop itself is single-threaded) —
  see "How it works".
* Screenshots are JPEG, not WebP: no pure-Rust WebP encoder; the contract allows both.
* The outbox seals the whole envelope, not just the payload.
* `data_gap.v1` events are protected from the storage cap like lifecycle events.
* `idle_auto` pauses are never emitted (no policy field asks for them).
* For the tray app the runtime publishes a `LiveStatus` snapshot to a `RuntimeObserver`
  every tick, accepts `Command::Preview { project_id }` (fetch and expose the policy a
  session would run under, collecting nothing) and keeps "today" totals of this device's
  emitted buckets (outbox meta `today_totals`, local calendar day).
* `Notice::LicenseUnavailable` became a struct variant (`{ block }`) so notices serialize
  for the UI.
