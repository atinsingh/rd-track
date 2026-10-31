//! OS integration traits.
//!
//! These traits are deliberately narrow: an [`InputCounter`] can only report *counts*
//! and the time since the last input, a [`ForegroundApp`] only an application identifier
//! and name, plus (Pro, when the policy asks for it) the hostname of the active browser
//! tab from the approved browser extension. There is no way to hand the core a key code,
//! typed text, clipboard content, a window title or a URL.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Status of an OS permission, as reported in heartbeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    /// The permission is granted.
    Granted,
    /// The user denied the permission.
    Denied,
    /// The platform does not need this permission.
    NotRequired,
    /// Status could not be determined.
    #[default]
    Unknown,
}

/// Input activity since the previous call to [`InputCounter::sample`].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct InputSample {
    /// Number of key-down events (count only).
    pub keyboard_count: u32,
    /// Number of mouse events (count only).
    pub mouse_count: u32,
    /// Whether the counts above are real (`false` when e.g. Input Monitoring is denied).
    pub counts_available: bool,
    /// Seconds since the last user input of any kind, if the OS reports it.
    pub seconds_since_last_input: Option<f64>,
}

/// Counts keyboard and mouse events. Implementations must discard each OS event
/// immediately after incrementing a counter.
pub trait InputCounter {
    /// Turns collection on or off. Called with `true` when a session becomes `Active`
    /// (implementations reset their counters) and `false` when it leaves `Active`
    /// (implementations should remove OS hooks).
    fn set_capturing(&mut self, capturing: bool);
    /// Returns and resets the counts accumulated since the previous call.
    fn sample(&mut self) -> InputSample;
    /// Input Monitoring permission status.
    fn permission(&self) -> PermissionStatus {
        PermissionStatus::NotRequired
    }
}

/// The application currently in the foreground.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ForegroundAppInfo {
    /// Stable identifier: bundle id on macOS, executable name on Windows.
    pub app_identifier: String,
    /// Display name of the application.
    pub app_name: String,
}

/// Reports the foreground application.
pub trait ForegroundApp {
    /// The current foreground application, or `None` (locked screen, no window).
    fn current(&mut self) -> Option<ForegroundAppInfo>;
    /// Accessibility permission status (where the platform needs one).
    fn permission(&self) -> PermissionStatus {
        PermissionStatus::NotRequired
    }
    /// Website domains are wanted at `now` (called every capture tick while the policy
    /// collects them) or no longer (`None`). See [`crate::browser`].
    fn want_domains(&mut self, now: Option<DateTime<Utc>>) {
        let _ = now;
    }
    /// The hostname of the active tab, when `app` is a supported browser whose extension
    /// reported one. Only asked while domains are wanted.
    fn active_domain(&mut self, app: &ForegroundAppInfo, now: DateTime<Utc>) -> Option<String> {
        let _ = (app, now);
        None
    }
    /// Browsers whose Track extension was heard from lately (reported in heartbeats).
    fn browser_extensions(&mut self, now: DateTime<Utc>) -> Vec<crate::browser::BrowserFamily> {
        let _ = now;
        Vec::new()
    }
}

impl<T: ForegroundApp + ?Sized> ForegroundApp for Box<T> {
    fn current(&mut self) -> Option<ForegroundAppInfo> {
        (**self).current()
    }
    fn permission(&self) -> PermissionStatus {
        (**self).permission()
    }
    fn want_domains(&mut self, now: Option<DateTime<Utc>>) {
        (**self).want_domains(now);
    }
    fn active_domain(&mut self, app: &ForegroundAppInfo, now: DateTime<Utc>) -> Option<String> {
        (**self).active_domain(app, now)
    }
    fn browser_extensions(&mut self, now: DateTime<Utc>) -> Vec<crate::browser::BrowserFamily> {
        (**self).browser_extensions(now)
    }
}

/// A captured frame: tightly packed RGBA8 pixels, row-major.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFrame {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes of RGBA.
    pub rgba: Vec<u8>,
}

/// Error from a screen capture.
#[derive(Debug, Error)]
pub enum CaptureError {
    /// Screen Recording permission is not granted.
    #[error("screen capture permission missing")]
    PermissionMissing,
    /// Any other platform failure.
    #[error("screen capture failed: {0}")]
    Failed(String),
}

/// Captures the screen. Used only by the screenshot pipeline after the server
/// authorised an upload.
pub trait ScreenCapturer: Send + Sync {
    /// Captures the primary monitor (or all monitors when `primary_monitor_only` is
    /// `false` and the platform supports it).
    fn capture(&self, primary_monitor_only: bool) -> Result<RawFrame, CaptureError>;
    /// Captures like [`ScreenCapturer::capture`], but lets the platform scale the frame
    /// down to at most `max_width` pixels wide while capturing (saving a full-resolution
    /// buffer on high-DPI screens). The pipeline downscales again if the frame is still
    /// wider, so implementations may ignore the hint; the default does.
    fn capture_scaled(
        &self,
        primary_monitor_only: bool,
        max_width: u32,
    ) -> Result<RawFrame, CaptureError> {
        let _ = max_width;
        self.capture(primary_monitor_only)
    }
    /// Screen Recording permission status.
    fn permission(&self) -> PermissionStatus {
        PermissionStatus::NotRequired
    }
}

/// Error from a [`CredentialStore`].
#[derive(Debug, Error)]
#[error("credential store error: {0}")]
pub struct CredentialError(pub String);

/// Secure storage for small secrets (device credential, outbox key).
/// Production: OS keychain. Development: a `0600` file.
pub trait CredentialStore: Send + Sync {
    /// Reads a secret.
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, CredentialError>;
    /// Writes (replaces) a secret.
    fn set(&self, name: &str, value: &[u8]) -> Result<(), CredentialError>;
    /// Deletes a secret; deleting a missing secret is not an error.
    fn delete(&self, name: &str) -> Result<(), CredentialError>;
}

/// Well-known [`CredentialStore`] entry names.
pub mod secret_names {
    /// The device credential returned by enrollment.
    pub const DEVICE_CREDENTIAL: &str = "device_credential";
    /// The 32-byte outbox sealing key.
    pub const OUTBOX_KEY: &str = "outbox_key";
}

/// HTTP method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `GET`
    Get,
    /// `POST`
    Post,
    /// `PUT`
    Put,
}

impl Method {
    /// Upper-case method name.
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
        }
    }
}

/// An HTTP request.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    /// Method.
    pub method: Method,
    /// Absolute URL.
    pub url: String,
    /// Header name/value pairs.
    pub headers: Vec<(String, String)>,
    /// Request body.
    pub body: Option<Vec<u8>>,
}

/// An HTTP response (any status code).
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Response body.
    pub body: Vec<u8>,
}

/// Transport-level failure (DNS, TCP, TLS, timeout) — no HTTP status was received.
#[derive(Debug, Error)]
#[error("transport error: {0}")]
pub struct TransportError(pub String);

/// Blocking HTTP client.
pub trait HttpTransport: Send + Sync {
    /// Sends a request and returns the response for any status code.
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, TransportError>;
}

/// The permission set reported in heartbeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Permissions {
    /// Input Monitoring (macOS) / hooks (Windows).
    pub input_monitoring: PermissionStatus,
    /// Screen Recording.
    pub screen_recording: PermissionStatus,
    /// Accessibility.
    pub accessibility: PermissionStatus,
}
