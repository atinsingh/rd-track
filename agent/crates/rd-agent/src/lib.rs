//! Shared building blocks of the RoundDigital Track desktop agent: the data directory,
//! credential stores, HTTP transport, enrollment, the native collectors and the
//! simulated platform. Used by the headless `rd-agent` binary and the tray app
//! (`rd-agent-desktop`).

pub mod browser_host;
pub mod config;
pub mod credentials;
pub mod http;
pub mod native;
pub mod setup;
pub mod simulated;
