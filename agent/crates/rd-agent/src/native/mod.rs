//! Native collectors behind `cfg(target_os)`.
//!
//! | | Windows ([`windows`]) | macOS ([`macos`]) | Linux |
//! |---|---|---|---|
//! | input counts | `WH_KEYBOARD_LL` / `WH_MOUSE_LL` hooks on a message-loop thread that only bump atomics | `CGEventSourceCounterForEventType` deltas | simulated |
//! | idle time | `GetLastInputInfo` | `CGEventSourceSecondsSinceLastEventType` | simulated |
//! | foreground app | `GetForegroundWindow` → process image | `NSWorkspace.frontmostApplication` | simulated |
//! | screen | GDI `StretchBlt` of the primary monitor | `CGDisplayCreateImage` of the main display | simulated |
//!
//! Nothing here reads a key code, scan code, character, window title or URL: the
//! hooks look only at the message kind, and the foreground lookups return a process
//! image / bundle identifier and a display name.

use std::sync::Arc;

use rd_agent_core::platform::{ForegroundApp, InputCounter, ScreenCapturer};

pub mod logic;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

/// `true` when this build has native collectors (Windows, macOS).
pub const AVAILABLE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

/// The native collectors for this OS.
pub struct NativePlatform {
    /// Input counter.
    pub input: Box<dyn InputCounter>,
    /// Foreground app.
    pub foreground: Box<dyn ForegroundApp>,
    /// Screen capturer.
    pub capturer: Arc<dyn ScreenCapturer>,
}

/// The native collectors, or `None` on platforms without them (Linux: use the
/// simulated platform). Must be called on the thread that will run the agent's tick
/// loop (collectors may keep thread-affine state).
pub fn platform() -> Option<NativePlatform> {
    #[cfg(target_os = "windows")]
    {
        Some(NativePlatform {
            input: Box::new(windows::HookInputCounter::new()),
            foreground: Box::new(windows::WinForeground::new()),
            capturer: Arc::new(windows::GdiCapturer),
        })
    }
    #[cfg(target_os = "macos")]
    {
        Some(NativePlatform {
            input: Box::new(macos::CounterInput::new()),
            foreground: Box::new(macos::MacForeground::new()),
            capturer: Arc::new(macos::DisplayCapturer),
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

/// An OS permission the employee may have to grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// macOS Screen Recording (screenshots).
    ScreenRecording,
    /// macOS Input Monitoring (only if event counters turn out to need it).
    InputMonitoring,
    /// macOS Accessibility (not used by this agent).
    Accessibility,
}

impl Permission {
    /// Stable name (heartbeat field, prompt ledger key).
    pub fn name(self) -> &'static str {
        match self {
            Permission::ScreenRecording => "screen_recording",
            Permission::InputMonitoring => "input_monitoring",
            Permission::Accessibility => "accessibility",
        }
    }

    /// Parses [`Permission::name`].
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "screen_recording" => Some(Permission::ScreenRecording),
            "input_monitoring" => Some(Permission::InputMonitoring),
            "accessibility" => Some(Permission::Accessibility),
            _ => None,
        }
    }

    /// The System Settings pane that grants it ("Fix in System Settings"), on macOS.
    pub fn settings_url(self) -> Option<&'static str> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        Some(match self {
            Permission::ScreenRecording => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Permission::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            Permission::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
        })
    }
}

/// Shows the OS permission prompt for `p` **at most once per install** (the caller
/// passes a [`logic::PromptLedger`] in the data directory). Returns `true` if a prompt
/// was requested now; afterwards only [`Permission::settings_url`] is offered. A no-op
/// returning `false` on platforms without such prompts.
pub fn request_permission_once(p: Permission, ledger: &logic::PromptLedger) -> bool {
    #[cfg(target_os = "macos")]
    {
        if p == Permission::Accessibility || !ledger.first_time(p.name()) {
            return false;
        }
        macos::request(p);
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (p, ledger);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_names_round_trip() {
        for p in [
            Permission::ScreenRecording,
            Permission::InputMonitoring,
            Permission::Accessibility,
        ] {
            assert_eq!(Permission::from_name(p.name()), Some(p));
            assert_eq!(p.settings_url().is_some(), cfg!(target_os = "macos"));
        }
        assert_eq!(Permission::from_name("camera"), None);
    }

    #[test]
    fn platform_availability_matches_build() {
        assert_eq!(platform().is_some(), AVAILABLE);
        let dir = tempfile::tempdir().unwrap();
        let ledger = logic::PromptLedger::new(dir.path());
        if !cfg!(target_os = "macos") {
            assert!(!request_permission_once(
                Permission::ScreenRecording,
                &ledger
            ));
            assert!(!ledger.was_prompted("screen_recording"));
        }
    }
}
