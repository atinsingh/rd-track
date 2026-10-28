# RoundDigital Track — desktop agent

A Cargo workspace with the platform-independent agent core and a headless binary.
Design: [`docs/design/01-system-design.md`](../docs/design/01-system-design.md) §5–§8.

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
    │       ├── runtime.rs     Agent (tick logic) + Runtime (1 Hz loop, network thread)
    │       └── ts.rs          RFC 3339 UTC formatting
    └── rd-agent/              binary: enroll / run / status
        └── src/
            ├── main.rs        CLI (clap)
            ├── http.rs        ureq + rustls transport, env proxies with NO_PROXY
            ├── credentials.rs 0600 file store (default) / OS keychain (feature `keychain`)
            ├── simulated.rs   seeded fake input, rotating fake apps, solid-colour screen
            └── config.rs      data directory layout, device.json
```

## Build and test

```sh
cd agent
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
cargo build --release -p rd-agent                 # target/release/rd-agent
cargo build --release -p rd-agent --features keychain
```

Requires a C compiler (SQLite is compiled in via `rusqlite/bundled`). MSRV 1.82.

## Using the binary

```sh
rd-agent enroll --server https://track.example.com --code ABCDEFGHJK [--device-name NAME] [--force]
rd-agent run --simulate [--project ID] [--task ID] [--seed N] [--duration SECS] [--stdin-control] [--no-auto-start]
rd-agent status [--json]
```

* `run` starts a session immediately (unless `--no-auto-start`) and tracks until Ctrl-C /
  SIGTERM (session stopped with reason `user`), or until `--duration` elapses. On exit it
  attempts a final sync for up to 10 s; anything left stays in the outbox for next time.
* `--stdin-control` accepts `start [project] [task]`, `pause`, `resume`, `stop`, `quit`.
* `--simulate` is required: native collectors are not part of this build.
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

## Credential storage

Development and CI use `FileCredentialStore` (`secrets/`, `0600`). Production uses the OS
keychain: build with `--features keychain` (the `keyring` crate: Windows Credential
Manager, macOS Keychain, Linux kernel keyutils — the latter does not survive a reboot,
which is fine because Linux is a development target only). `RD_AGENT_CREDENTIAL_STORE=file`
forces the file store in a keychain build.

## Native collectors (next increment, not in this build)

| | Windows | macOS |
|---|---|---|
| `InputCounter` | `SetWindowsHookEx(WH_KEYBOARD_LL / WH_MOUSE_LL)` on a dedicated message-loop thread; the hook proc only increments an atomic counter and calls `CallNextHookEx` — the `KBDLLHOOKSTRUCT` is never read beyond the event kind. `GetLastInputInfo` for seconds since last input. Hooks installed on `set_capturing(true)`, removed on `false`. | `CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, …)` deltas for key-down / mouse events (no event tap, no key codes); `CGEventSourceSecondsSinceLastEventType` for idle time. Missing Input Monitoring → `counts_available = false` → `partial`/`permission_missing` buckets, reported once in the heartbeat. |
| `ForegroundApp` | `GetForegroundWindow` → `GetWindowThreadProcessId` → `QueryFullProcessImageNameW`; identifier = executable name, name = file description. Window title never read. | `NSWorkspace.sharedWorkspace.frontmostApplication` → `bundleIdentifier`, `localizedName`. |
| `ScreenCapturer` | DXGI Desktop Duplication (primary output) or `BitBlt` fallback. | ScreenCaptureKit `SCScreenshotManager` (macOS 14+), Screen Recording permission. |
| `CredentialStore` | Credential Manager (`keyring` `windows-native`). | Keychain (`keyring` `apple-native`). |

These would live in `rd-agent/src/platform/{windows,macos}.rs` behind `cfg(target_os)`;
the core needs no changes.

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
