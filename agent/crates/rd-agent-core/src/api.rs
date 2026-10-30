//! Wire types and a blocking client for the agent endpoints (system design §5.2).
//!
//! All JSON is `snake_case`; timestamps are RFC 3339 UTC. Response types are lenient
//! where the agent does not depend on a field (unknown fields are ignored, optional
//! fields default), so a server-side addition never breaks an agent in the field.
//! Nothing here logs request or response bodies.

use std::collections::BTreeMap;
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::events::Envelope;
use crate::platform::{HttpRequest, HttpTransport, Method, Permissions};
use crate::policy::{PinnedKey, SignedPolicy};

/// Maximum serialized size of an ingestion batch (1 MiB).
pub const MAX_BATCH_BYTES: usize = 1024 * 1024;
/// Maximum events per ingestion batch.
pub const MAX_BATCH_EVENTS: usize = 500;

/// Operating system reported at enrollment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Os {
    /// Windows.
    Windows,
    /// macOS.
    Macos,
    /// Linux (simulated / development only).
    Linux,
}

impl Os {
    /// The OS this binary was compiled for.
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Linux
        }
    }
}

/// `POST /v1/devices/enrollment-requests` request (G26).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailCodeRequest {
    /// The key from the deployment file.
    pub deployment_key: String,
    /// The person's work email.
    pub email: String,
}

/// `POST /v1/devices/enroll` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollRequest {
    /// One-time enrollment code.
    pub enrollment_code: String,
    /// Human-readable device name.
    pub device_name: String,
    /// Operating system.
    pub os: Os,
    /// OS version string.
    pub os_version: String,
    /// Agent version.
    pub agent_version: String,
}

/// `POST /v1/devices/enroll` response (`201`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollResponse {
    /// New device id.
    pub device_id: String,
    /// User the device belongs to.
    pub user_id: String,
    /// Organization.
    pub organization_id: String,
    /// The device credential (returned once).
    pub device_credential: String,
    /// Policy signing key to pin.
    pub policy_signing_key: PinnedKey,
    /// The employee's own dashboard (servers before Stage 3 omit it).
    #[serde(default)]
    pub dashboard_url: Option<String>,
}

/// `POST /v1/device/heartbeat` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    /// Agent version.
    pub agent_version: String,
    /// Device wall clock.
    #[serde(with = "crate::ts")]
    pub client_time: DateTime<Utc>,
    /// Permission status.
    pub permissions: Permissions,
    /// Events waiting in the outbox.
    pub outbox_depth: u64,
    /// Highest policy revision applied.
    pub applied_policy_revision: i64,
}

/// `POST /v1/device/heartbeat` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HeartbeatResponse {
    /// Server clock.
    #[serde(with = "crate::ts::option")]
    pub server_time: Option<DateTime<Utc>>,
    /// Current organization policy revision.
    pub policy_revision: i64,
    /// `active` or `revoked`.
    pub credential_status: String,
    /// Licence state of the organization (optional; malformed values become `None`).
    #[serde(
        deserialize_with = "lenient_license",
        skip_serializing_if = "Option::is_none"
    )]
    pub license: Option<LicenseInfo>,
    /// The person's language and formats (`fr-CA`…); `None` lets the computer decide.
    pub locale: Option<String>,
}

/// Licence status reported in heartbeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    /// Paid and current.
    Active,
    /// Lapsed but within the grace period.
    Grace,
    /// Lapsed past grace.
    Inactive,
    /// A status this agent does not know.
    #[default]
    #[serde(other)]
    Unknown,
}

/// The heartbeat `license` object: `{status, grace_ends_at?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct LicenseInfo {
    /// Licence status.
    pub status: LicenseStatus,
    /// End of the grace period, when in grace.
    #[serde(with = "crate::ts::option", skip_serializing_if = "Option::is_none")]
    pub grace_ends_at: Option<DateTime<Utc>>,
}

fn lenient_license<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<LicenseInfo>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()))
}

/// Why the server refuses service to this user/organization (`403`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseBlock {
    /// `subscription_inactive`: the organization's licence lapsed past grace.
    SubscriptionInactive,
    /// `seat_unavailable`: this user has no licensed seat.
    SeatUnavailable,
}

impl LicenseBlock {
    /// Maps a server error code.
    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "subscription_inactive" => Some(Self::SubscriptionInactive),
            "seat_unavailable" => Some(Self::SeatUnavailable),
            _ => None,
        }
    }

    /// The server error code.
    pub fn code(self) -> &'static str {
        match self {
            Self::SubscriptionInactive => "subscription_inactive",
            Self::SeatUnavailable => "seat_unavailable",
        }
    }

    /// Text shown to the employee.
    pub fn message(self) -> &'static str {
        self.message_in(crate::i18n::Lang::En)
    }

    /// The same, in `lang`.
    pub fn message_in(self, lang: crate::i18n::Lang) -> &'static str {
        let m = lang.messages();
        match self {
            Self::SubscriptionInactive => m.license_inactive,
            Self::SeatUnavailable => m.license_no_seat,
        }
    }
}

/// A task in a [`DeviceProject`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceTask {
    /// Task id.
    pub id: String,
    /// Display name.
    pub name: String,
}

/// A project the device's user can book time to (`GET /v1/device/projects`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceProject {
    /// Project id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Open tasks (may be empty or omitted).
    #[serde(default)]
    pub tasks: Vec<DeviceTask>,
}

/// Accepts both `[...]` and `{"projects": [...]}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum DeviceProjectList {
    Bare(Vec<DeviceProject>),
    Wrapped { projects: Vec<DeviceProject> },
}

/// Time worked so far today (`GET /v1/device/work-limits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkedToday {
    /// The person's local date (in [`WorkLimits::timezone`]).
    pub date: NaiveDate,
    /// Seconds worked on that date, the running session left out when asked.
    pub worked_seconds: u64,
}

/// Time worked so far this week (`GET /v1/device/work-limits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkedWeek {
    /// Monday of the ISO week.
    pub period_start: NaiveDate,
    /// Seconds worked in the week, the running session left out when asked.
    pub worked_seconds: u64,
}

/// `GET /v1/device/work-limits` with `enabled: true` (Stage 4 F4): the person's daily
/// and weekly limits and the time worked so far. Sessions count on the local day they
/// start on. Read only by the agent, for local warnings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkLimits {
    /// Server time of the figures.
    #[serde(with = "crate::ts")]
    pub as_of: DateTime<Utc>,
    /// IANA time zone the dates are in.
    pub timezone: String,
    /// Daily limit (`None` = no daily limit).
    #[serde(default)]
    pub daily_minutes: Option<u32>,
    /// Weekly limit (`None` = no weekly limit).
    #[serde(default)]
    pub weekly_minutes: Option<u32>,
    /// Today so far.
    pub today: WorkedToday,
    /// This week so far.
    pub week: WorkedWeek,
}

/// Today's shift (`GET /v1/device/schedule-today`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledShift {
    /// Shift start.
    #[serde(with = "crate::ts")]
    pub start_at: DateTime<Utc>,
    /// Shift end.
    #[serde(with = "crate::ts")]
    pub end_at: DateTime<Utc>,
}

/// Why today is not a working day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DayOff {
    /// An organization holiday.
    Holiday,
    /// Today's shift was cancelled.
    Cancelled,
    /// Approved full-day leave.
    Leave,
    /// A reason this agent does not know (still a day off).
    #[serde(other)]
    Other,
}

/// `GET /v1/device/schedule-today` (Stage 4 F3): the person's working hours today, so
/// reminders stay inside them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleToday {
    /// The person's local date.
    pub date: NaiveDate,
    /// IANA time zone of `date`.
    pub timezone: String,
    /// `false`: no schedule (the agent uses the hours the person set).
    pub scheduled: bool,
    /// Today's shift; `None` with `scheduled` means not a working day.
    #[serde(default)]
    pub shift: Option<ScheduledShift>,
    /// A holiday, cancelled shift or full-day leave: no reminders.
    #[serde(default)]
    pub day_off: Option<DayOff>,
}

/// `POST /v1/ingestion/event-batches` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventBatchRequest {
    /// Random batch id (UUIDv4).
    pub batch_id: Uuid,
    /// Device clock at send time (server derives the clock offset from it).
    #[serde(with = "crate::ts")]
    pub sent_at: DateTime<Utc>,
    /// 1..=500 envelopes, oldest first.
    pub events: Vec<Envelope>,
}

/// Per-event ingestion status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventStatus {
    /// Stored.
    Accepted,
    /// Already stored earlier (idempotent replay).
    Duplicate,
    /// Invalid; will never be accepted.
    Rejected,
    /// A status this agent does not know; the event is kept and retried.
    #[serde(other)]
    Unknown,
}

/// One entry of the ingestion `results` array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventResult {
    /// Event id.
    pub event_id: Uuid,
    /// Status.
    pub status: EventStatus,
    /// Reason code for `rejected`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `POST /v1/ingestion/event-batches` response (`200`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct EventBatchResponse {
    /// Server clock.
    #[serde(default, with = "crate::ts::option")]
    pub server_time: Option<DateTime<Utc>>,
    /// Per-event results.
    #[serde(default)]
    pub results: Vec<EventResult>,
}

/// Screenshot image content type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageContentType {
    /// `image/webp`
    #[serde(rename = "image/webp")]
    Webp,
    /// `image/jpeg`
    #[serde(rename = "image/jpeg")]
    Jpeg,
}

impl ImageContentType {
    /// MIME string.
    pub fn as_str(self) -> &'static str {
        match self {
            ImageContentType::Webp => "image/webp",
            ImageContentType::Jpeg => "image/jpeg",
        }
    }
}

/// `POST /v1/screenshots/upload-intents` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadIntentRequest {
    /// Active session.
    pub session_id: Uuid,
    /// Image type that will be uploaded.
    pub content_type: ImageContentType,
}

/// `POST /v1/screenshots/upload-intents` response (`201`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadIntentResponse {
    /// Screenshot id.
    pub screenshot_id: String,
    /// Presigned PUT URL.
    pub upload_url: String,
    /// Headers that must accompany the PUT.
    #[serde(default)]
    pub upload_headers: BTreeMap<String, String>,
    /// URL expiry.
    #[serde(default, with = "crate::ts::option")]
    pub expires_at: Option<DateTime<Utc>>,
}

/// `POST /v1/screenshots/complete` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompleteRequest {
    /// Screenshot id from the intent.
    pub screenshot_id: String,
    /// Capture time.
    #[serde(with = "crate::ts")]
    pub captured_at: DateTime<Utc>,
    /// Lower-case hex SHA-256 of the uploaded bytes.
    pub sha256: String,
    /// Uploaded byte count.
    pub bytes: u64,
    /// Image width.
    pub width: u32,
    /// Image height.
    pub height: u32,
}

/// `POST /v1/screenshots/complete` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CompleteResponse {
    /// `verifying`.
    pub status: String,
}

/// API failure.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// No HTTP response (network down, DNS, TLS, timeout).
    #[error("network error: {0}")]
    Transport(String),
    /// `401 device_revoked`.
    #[error("device credential revoked")]
    DeviceRevoked,
    /// The client has no device credential.
    #[error("device is not enrolled")]
    NotEnrolled,
    /// `403 subscription_inactive` / `403 seat_unavailable`.
    #[error("{}", .0.message())]
    LicenseUnavailable(LicenseBlock),
    /// Any other non-2xx status.
    #[error("HTTP {status}{}", code.as_deref().map(|c| format!(" ({c})")).unwrap_or_default())]
    Http {
        /// Status code.
        status: u16,
        /// Error code from the body, if present.
        code: Option<String>,
    },
    /// A 2xx response whose body could not be decoded.
    #[error("could not decode response: {0}")]
    Decode(String),
}

impl ApiError {
    /// `true` for errors worth retrying with backoff.
    pub fn is_retryable(&self) -> bool {
        match self {
            ApiError::Transport(_) | ApiError::Decode(_) => true,
            ApiError::Http { status, .. } => *status >= 500 || *status == 429 || *status == 408,
            ApiError::DeviceRevoked | ApiError::NotEnrolled | ApiError::LicenseUnavailable(_) => {
                false
            }
        }
    }

    /// The server error code, if any.
    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Http { code, .. } => code.as_deref(),
            ApiError::DeviceRevoked => Some("device_revoked"),
            ApiError::LicenseUnavailable(b) => Some(b.code()),
            _ => None,
        }
    }
}

/// Extracts `error.code` (standard error envelope) or a top-level `code`.
pub fn error_code(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.get("error")
        .and_then(|e| e.get("code"))
        .or_else(|| v.get("code"))
        .and_then(|c| c.as_str())
        .map(|s| s.chars().take(100).collect())
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Normalises a server URL: trims whitespace and trailing `/`, strips a `/v1` suffix.
pub fn normalize_base_url(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_owned();
    if u.ends_with("/v1") {
        u.truncate(u.len() - 3);
    }
    u
}

/// Blocking client for the agent endpoints.
#[derive(Clone)]
pub struct ApiClient {
    base: String,
    transport: Arc<dyn HttpTransport>,
    credential: Option<String>,
}

impl std::fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiClient")
            .field("base", &self.base)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl ApiClient {
    /// Creates a client for `base_url` (e.g. `https://track.example.com`).
    pub fn new(base_url: &str, transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            base: normalize_base_url(base_url),
            transport,
            credential: None,
        }
    }

    /// Sets the device credential used as `Authorization: Device <credential>`.
    pub fn with_credential(mut self, credential: impl Into<String>) -> Self {
        self.credential = Some(credential.into());
        self
    }

    /// The normalised base URL.
    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}/v1{}", self.base, path)
    }

    fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        url: String,
        body: Option<Vec<u8>>,
        authenticated: bool,
    ) -> Result<T, ApiError> {
        let mut headers = vec![
            ("accept".to_owned(), "application/json".to_owned()),
            (
                "user-agent".to_owned(),
                format!("rd-agent/{}", crate::AGENT_VERSION),
            ),
        ];
        if body.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        if authenticated {
            let cred = self.credential.as_ref().ok_or(ApiError::NotEnrolled)?;
            headers.push(("authorization".to_owned(), format!("Device {cred}")));
        }
        let resp = self
            .transport
            .send(HttpRequest {
                method,
                url,
                headers,
                body,
            })
            .map_err(|e| ApiError::Transport(e.0))?;
        if (200..300).contains(&resp.status) {
            let body = if resp.body.is_empty() {
                b"{}".as_slice()
            } else {
                &resp.body
            };
            return serde_json::from_slice(body).map_err(|e| ApiError::Decode(e.to_string()));
        }
        let code = error_code(&resp.body);
        if resp.status == 401 && code.as_deref() == Some("device_revoked") {
            return Err(ApiError::DeviceRevoked);
        }
        if resp.status == 403 {
            if let Some(block) = code.as_deref().and_then(LicenseBlock::from_code) {
                return Err(ApiError::LicenseUnavailable(block));
            }
        }
        Err(ApiError::Http {
            status: resp.status,
            code,
        })
    }

    fn json<T: Serialize>(v: &T) -> Result<Vec<u8>, ApiError> {
        serde_json::to_vec(v).map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// `POST /v1/devices/enroll` (public).
    pub fn enroll(&self, req: &EnrollRequest) -> Result<EnrollResponse, ApiError> {
        self.call(
            Method::Post,
            self.url("/devices/enroll"),
            Some(Self::json(req)?),
            false,
        )
    }

    /// `POST /v1/devices/enrollment-requests` (public, G26): on a computer IT deployed, asks
    /// the server to email the person a one-time code. The answer is the same whether or not
    /// the email belongs to someone who can connect.
    pub fn request_email_code(&self, req: &EmailCodeRequest) -> Result<(), ApiError> {
        let _: serde_json::Value = self.call(
            Method::Post,
            self.url("/devices/enrollment-requests"),
            Some(Self::json(req)?),
            false,
        )?;
        Ok(())
    }

    /// `POST /v1/device/heartbeat`.
    pub fn heartbeat(&self, req: &HeartbeatRequest) -> Result<HeartbeatResponse, ApiError> {
        self.call(
            Method::Post,
            self.url("/device/heartbeat"),
            Some(Self::json(req)?),
            true,
        )
    }

    /// `GET /v1/device/policy[?project_id=…]`.
    pub fn policy(&self, project_id: Option<&str>) -> Result<SignedPolicy, ApiError> {
        let mut url = self.url("/device/policy");
        if let Some(p) = project_id {
            url.push_str("?project_id=");
            url.push_str(&percent_encode(p));
        }
        self.call(Method::Get, url, None, true)
    }

    /// `GET /v1/device/projects` — the projects (and their open tasks) this device's
    /// user can book time to, for the tray's pickers. A `404` means an older server
    /// that does not offer it
    /// and the tray falls back to "No project".
    pub fn projects(&self) -> Result<Vec<DeviceProject>, ApiError> {
        let list: DeviceProjectList =
            self.call(Method::Get, self.url("/device/projects"), None, true)?;
        Ok(match list {
            DeviceProjectList::Bare(v) | DeviceProjectList::Wrapped { projects: v } => v,
        })
    }

    /// `GET /v1/device/work-limits[?exclude_session_id=…]` — `None` when the plan has
    /// no work limits (`enabled: false`). `exclude` is the running session, which the
    /// agent counts itself.
    pub fn work_limits(&self, exclude: Option<Uuid>) -> Result<Option<WorkLimits>, ApiError> {
        let mut url = self.url("/device/work-limits");
        if let Some(id) = exclude {
            url.push_str("?exclude_session_id=");
            url.push_str(&id.to_string());
        }
        let v: serde_json::Value = self.call(Method::Get, url, None, true)?;
        if v.get("enabled").and_then(serde_json::Value::as_bool) != Some(true) {
            return Ok(None);
        }
        serde_json::from_value(v)
            .map(Some)
            .map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// `GET /v1/device/schedule-today`.
    pub fn schedule_today(&self) -> Result<ScheduleToday, ApiError> {
        self.call(Method::Get, self.url("/device/schedule-today"), None, true)
    }

    /// Serializes a batch request.
    pub fn encode_batch(req: &EventBatchRequest) -> Result<Vec<u8>, ApiError> {
        Self::json(req)
    }

    /// `POST /v1/ingestion/event-batches` with a pre-serialized body.
    pub fn send_batch_bytes(&self, body: Vec<u8>) -> Result<EventBatchResponse, ApiError> {
        self.call(
            Method::Post,
            self.url("/ingestion/event-batches"),
            Some(body),
            true,
        )
    }

    /// `POST /v1/screenshots/upload-intents`.
    pub fn upload_intent(
        &self,
        req: &UploadIntentRequest,
    ) -> Result<UploadIntentResponse, ApiError> {
        self.call(
            Method::Post,
            self.url("/screenshots/upload-intents"),
            Some(Self::json(req)?),
            true,
        )
    }

    /// `PUT` the image to the presigned URL (no device credential is sent there).
    pub fn upload_object(
        &self,
        intent: &UploadIntentResponse,
        content_type: ImageContentType,
        bytes: Vec<u8>,
    ) -> Result<(), ApiError> {
        let mut headers: Vec<(String, String)> = intent
            .upload_headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        {
            headers.push(("content-type".to_owned(), content_type.as_str().to_owned()));
        }
        let resp = self
            .transport
            .send(HttpRequest {
                method: Method::Put,
                url: intent.upload_url.clone(),
                headers,
                body: Some(bytes),
            })
            .map_err(|e| ApiError::Transport(e.0))?;
        if (200..300).contains(&resp.status) {
            Ok(())
        } else {
            Err(ApiError::Http {
                status: resp.status,
                code: None,
            })
        }
    }

    /// `POST /v1/screenshots/complete`.
    pub fn complete_screenshot(&self, req: &CompleteRequest) -> Result<CompleteResponse, ApiError> {
        self.call(
            Method::Post,
            self.url("/screenshots/complete"),
            Some(Self::json(req)?),
            true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeTransport;
    use chrono::TimeZone;
    use serde_json::json;

    #[test]
    fn enroll_request_and_response_shapes() {
        let t = FakeTransport::new();
        t.push(
            201,
            json!({"device_id": "d1", "user_id": "u1", "organization_id": "o1",
                   "device_credential": "secret",
                   "policy_signing_key": {"key_id": "k1", "public_key_b64": "AAAA"},
                   "extra": true}),
        );
        let api = ApiClient::new("https://x.test/v1/", t.clone());
        let resp = api
            .enroll(&EnrollRequest {
                enrollment_code: "ABCDEFGHJK".into(),
                device_name: "laptop".into(),
                os: Os::Macos,
                os_version: "15.1".into(),
                agent_version: "0.1.0".into(),
            })
            .unwrap();
        assert_eq!(resp.device_credential, "secret");
        let req = t.requests().remove(0);
        assert_eq!(req.url, "https://x.test/v1/devices/enroll");
        assert!(!req.headers.iter().any(|(k, _)| k == "authorization"));
        let body: serde_json::Value = serde_json::from_slice(&req.body.unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"enrollment_code": "ABCDEFGHJK", "device_name": "laptop", "os": "macos",
                   "os_version": "15.1", "agent_version": "0.1.0"})
        );
    }

    #[test]
    fn authenticated_calls_send_device_credential_and_map_errors() {
        let t = FakeTransport::new();
        let api = ApiClient::new("http://h", t.clone()).with_credential("c");
        t.push(
            200,
            json!({"server_time": "2026-10-28T09:00:00Z", "policy_revision": 3, "credential_status": "active"}),
        );
        let hb = api
            .heartbeat(&HeartbeatRequest {
                agent_version: "0.1.0".into(),
                client_time: Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap(),
                permissions: Permissions::default(),
                outbox_depth: 4,
                applied_policy_revision: 2,
            })
            .unwrap();
        assert_eq!(hb.policy_revision, 3);
        let req = &t.requests()[0];
        assert!(req
            .headers
            .contains(&("authorization".into(), "Device c".into())));
        let body: serde_json::Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
        assert_eq!(
            body["permissions"],
            json!({"input_monitoring": "unknown", "screen_recording": "unknown", "accessibility": "unknown"})
        );
        assert_eq!(body["client_time"], "2026-10-28T09:00:00Z");

        t.push(
            401,
            json!({"error": {"code": "device_revoked", "message": "x"}}),
        );
        assert_eq!(
            api.policy(Some("a b")).unwrap_err(),
            ApiError::DeviceRevoked
        );
        assert!(t.requests()[1]
            .url
            .ends_with("/v1/device/policy?project_id=a%20b"));

        t.push(403, json!({"code": "screenshots_disabled"}));
        let e = api
            .upload_intent(&UploadIntentRequest {
                session_id: Uuid::nil(),
                content_type: ImageContentType::Jpeg,
            })
            .unwrap_err();
        assert_eq!(e.code(), Some("screenshots_disabled"));
        assert!(!e.is_retryable());

        t.push(
            200,
            json!({"projects": [{"id": "p1", "name": "Client A", "tasks": [{"id": "t1", "name": "QA pass"}], "extra": 1}]}),
        );
        let projects = api.projects().unwrap();
        assert_eq!(projects[0].tasks[0].name, "QA pass");
        assert!(t
            .requests()
            .last()
            .unwrap()
            .url
            .ends_with("/v1/device/projects"));
        t.push(200, json!([{"id": "p2", "name": "Internal"}]));
        assert!(api.projects().unwrap()[0].tasks.is_empty());

        t.push_raw(200, b"not json".to_vec());
        assert!(matches!(api.policy(None), Err(ApiError::Decode(_))));
        t.push_raw(503, vec![]);
        assert!(api.policy(None).unwrap_err().is_retryable());
        t.fail_next("connection refused");
        assert!(matches!(api.policy(None), Err(ApiError::Transport(_))));

        let unenrolled = ApiClient::new("http://h", t);
        assert_eq!(unenrolled.policy(None).unwrap_err(), ApiError::NotEnrolled);
    }

    #[test]
    fn license_errors_and_heartbeat_license_field() {
        let t = FakeTransport::new();
        let api = ApiClient::new("http://h", t.clone()).with_credential("c");
        t.push(
            403,
            json!({"error": {"code": "subscription_inactive", "message": "m", "request_id": "r"}}),
        );
        assert_eq!(
            api.policy(None).unwrap_err(),
            ApiError::LicenseUnavailable(LicenseBlock::SubscriptionInactive)
        );
        t.push(
            403,
            json!({"error": {"code": "seat_unavailable", "message": "m"}}),
        );
        let e = api.send_batch_bytes(b"{}".to_vec()).unwrap_err();
        assert_eq!(
            e,
            ApiError::LicenseUnavailable(LicenseBlock::SeatUnavailable)
        );
        assert!(!e.is_retryable());
        assert_eq!(e.code(), Some("seat_unavailable"));
        // Other 403s stay generic.
        t.push(403, json!({"error": {"code": "forbidden"}}));
        assert!(matches!(
            api.policy(None),
            Err(ApiError::Http { status: 403, .. })
        ));

        let parse = |v: serde_json::Value| serde_json::from_value::<HeartbeatResponse>(v).unwrap();
        let r = parse(json!({"policy_revision": 1, "credential_status": "active",
                             "license": {"status": "grace", "grace_ends_at": "2026-11-01T00:00:00Z"}}));
        let lic = r.license.unwrap();
        assert_eq!(lic.status, LicenseStatus::Grace);
        assert_eq!(lic.grace_ends_at, crate::ts::parse("2026-11-01T00:00:00Z"));
        assert_eq!(parse(json!({"policy_revision": 1})).license, None);
        assert_eq!(parse(json!({"license": null})).license, None);
        assert_eq!(parse(json!({"license": "weird"})).license, None);
        assert_eq!(
            parse(json!({"license": {"status": "platinum", "grace_ends_at": "soon"}})).license,
            Some(LicenseInfo {
                status: LicenseStatus::Unknown,
                grace_ends_at: None
            })
        );
        assert_eq!(
            parse(json!({"license": {"status": "inactive"}}))
                .license
                .unwrap()
                .status,
            LicenseStatus::Inactive
        );
    }

    #[test]
    fn work_limits_endpoint() {
        let t = FakeTransport::new();
        let api = ApiClient::new("http://h", t.clone()).with_credential("c");
        t.push(
            200,
            json!({"enabled": true, "as_of": "2026-10-28T15:00:00.000Z", "timezone": "Europe/Riga",
                   "daily_minutes": 480, "weekly_minutes": null,
                   "today": {"date": "2026-10-28", "worked_seconds": 1800},
                   "week": {"period_start": "2026-10-26", "worked_seconds": 5400}, "extra": 1}),
        );
        let session = Uuid::parse_str("6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b").unwrap();
        let l = api.work_limits(Some(session)).unwrap().unwrap();
        assert_eq!(l.daily_minutes, Some(480));
        assert_eq!(l.weekly_minutes, None);
        assert_eq!(l.today.date, NaiveDate::from_ymd_opt(2026, 10, 28).unwrap());
        assert_eq!(l.week.worked_seconds, 5400);
        assert_eq!(l.timezone, "Europe/Riga");
        let req = t.requests().remove(0);
        assert_eq!(req.method, Method::Get);
        assert!(req.url.ends_with(
            "/v1/device/work-limits?exclude_session_id=6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
        ));
        assert!(req
            .headers
            .contains(&("authorization".into(), "Device c".into())));

        // Plans without work limits.
        t.push(200, json!({"enabled": false}));
        assert_eq!(api.work_limits(None).unwrap(), None);
        assert!(t.requests()[1].url.ends_with("/v1/device/work-limits"));
        // `enabled: true` without the figures is a decode error (the last good copy stays).
        t.push(200, json!({"enabled": true, "timezone": "UTC"}));
        assert!(matches!(api.work_limits(None), Err(ApiError::Decode(_))));

        t.push(
            401,
            json!({"error": {"code": "device_revoked", "message": "x"}}),
        );
        assert_eq!(api.work_limits(None).unwrap_err(), ApiError::DeviceRevoked);
        t.push(401, json!({"error": {"code": "unauthorized"}}));
        assert!(matches!(
            api.work_limits(None),
            Err(ApiError::Http { status: 401, .. })
        ));
        t.fail_next("connection refused");
        assert!(matches!(api.work_limits(None), Err(ApiError::Transport(_))));
        let unenrolled = ApiClient::new("http://h", t);
        assert_eq!(
            unenrolled.work_limits(None).unwrap_err(),
            ApiError::NotEnrolled
        );
    }

    #[test]
    fn schedule_today_endpoint() {
        let t = FakeTransport::new();
        let api = ApiClient::new("http://h", t.clone()).with_credential("c");
        t.push(
            200,
            json!({"date": "2026-10-28", "timezone": "UTC", "scheduled": true,
                   "shift": {"start_at": "2026-10-28T09:00:00.000Z", "end_at": "2026-10-28T17:00:00.000Z"},
                   "day_off": null}),
        );
        let s = api.schedule_today().unwrap();
        assert!(s.scheduled);
        let shift = s.shift.unwrap();
        assert_eq!(
            shift.start_at,
            crate::ts::parse("2026-10-28T09:00:00Z").unwrap()
        );
        assert_eq!(
            shift.end_at,
            crate::ts::parse("2026-10-28T17:00:00Z").unwrap()
        );
        assert_eq!(s.day_off, None);
        assert!(t.requests()[0].url.ends_with("/v1/device/schedule-today"));

        t.push(
            200,
            json!({"date": "2026-10-28", "timezone": "UTC", "scheduled": true, "shift": null, "day_off": "holiday"}),
        );
        assert_eq!(api.schedule_today().unwrap().day_off, Some(DayOff::Holiday));
        t.push(
            200,
            json!({"date": "2026-10-28", "timezone": "UTC", "scheduled": false, "day_off": "sabbatical"}),
        );
        let s = api.schedule_today().unwrap();
        assert_eq!(s.shift, None);
        assert_eq!(
            s.day_off,
            Some(DayOff::Other),
            "unknown reasons are still a day off"
        );

        t.push(
            401,
            json!({"error": {"code": "device_revoked", "message": "x"}}),
        );
        assert_eq!(api.schedule_today().unwrap_err(), ApiError::DeviceRevoked);
        t.push(404, json!({"error": {"code": "not_found"}}));
        assert!(matches!(
            api.schedule_today(),
            Err(ApiError::Http { status: 404, .. })
        ));
        t.fail_next("offline");
        assert!(matches!(api.schedule_today(), Err(ApiError::Transport(_))));
    }

    #[test]
    fn batch_response_handles_unknown_status() {
        let v = json!({"server_time": "2026-10-28T09:00:00Z", "results": [
            {"event_id": "00000000-0000-0000-0000-000000000000", "status": "accepted"},
            {"event_id": "00000000-0000-0000-0000-000000000001", "status": "rejected", "reason": "unknown_session"},
            {"event_id": "00000000-0000-0000-0000-000000000002", "status": "deferred"}
        ]});
        let r: EventBatchResponse = serde_json::from_value(v).unwrap();
        assert_eq!(r.results[1].reason.as_deref(), Some("unknown_session"));
        assert_eq!(r.results[2].status, EventStatus::Unknown);
    }

    #[test]
    fn upload_uses_presigned_url_without_credential() {
        let t = FakeTransport::new();
        let api = ApiClient::new("http://h", t.clone()).with_credential("c");
        t.push_raw(200, vec![]);
        let intent = UploadIntentResponse {
            screenshot_id: "s".into(),
            upload_url: "http://minio/bucket/key?sig=1".into(),
            upload_headers: [("x-amz-meta-a".to_string(), "1".to_string())].into(),
            expires_at: None,
        };
        api.upload_object(&intent, ImageContentType::Jpeg, vec![1, 2, 3])
            .unwrap();
        let req = &t.requests()[0];
        assert_eq!(req.method, Method::Put);
        assert_eq!(req.url, "http://minio/bucket/key?sig=1");
        assert!(!req.headers.iter().any(|(k, _)| k == "authorization"));
        assert!(req
            .headers
            .contains(&("content-type".into(), "image/jpeg".into())));
    }

    #[test]
    fn base_url_normalization() {
        assert_eq!(normalize_base_url(" https://a.test/v1/ "), "https://a.test");
        assert_eq!(
            normalize_base_url("http://localhost:3000"),
            "http://localhost:3000"
        );
    }
}
