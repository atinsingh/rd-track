//! Platform-independent core of the RoundDigital Track desktop agent.
//!
//! The agent records **aggregated** computer activity while — and only while — an
//! employee has an explicitly started work session in the `Active` state. It never
//! records key identities, typed text, clipboard contents, window titles or URLs; the
//! platform traits in [`platform`] are shaped so that such data cannot even be passed in.
//!
//! Module map (see `docs/design/01-system-design.md` §8):
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`state`] | Session state machine, emits lifecycle events |
//! | [`activity`] | Per-second samples → UTC-minute buckets with idle attribution |
//! | [`apps`] | Foreground-app samples → `app_usage` segments |
//! | [`screenshot`] | Randomised screenshot slots and the capture/upload pipeline |
//! | [`policy`] | Signed policy verification, typed settings, work hours |
//! | [`limits`] | Work-limit warnings at 80% / 100% (local only) |
//! | [`reminders`] | Start / stop / "still tracking?" reminders (local only) |
//! | [`outbox`] | Encrypted SQLite outbox with a persistent sequence counter |
//! | [`sync`] | Batching, per-event result handling, backoff |
//! | [`clock`] | Wall + monotonic clock, suspend / clock-change detection |
//! | [`describe`] | Plain-language "what this session collects" (session-start notice) |
//! | [`platform`] | OS integration traits |
//! | [`api`] | Wire types and a client for the agent endpoints |
//! | [`events`] | The event envelope and strict payload types |
//! | [`runtime`] | The [`runtime::Agent`] tick logic and the 1 Hz run loop |

pub mod activity;
pub mod api;
pub mod apps;
pub mod clock;
pub mod describe;
pub mod events;
pub mod identity;
pub mod limits;
pub mod outbox;
pub mod platform;
pub mod policy;
pub mod reminders;
pub mod runtime;
pub mod screenshot;
pub mod state;
pub mod sync;
pub mod ts;

#[cfg(test)]
pub(crate) mod testing;

/// Version string reported to the server in enrollment and heartbeats.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
