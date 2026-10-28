//! Signed policy delivery, typed settings and the work-hours check (system design §6.4).
//!
//! `GET /v1/device/policy` returns `{payload_b64, signature_b64, key_id}`. The agent
//! verifies the Ed25519 signature over the **exact decoded payload bytes** before
//! parsing anything, checks that the document is for this device and the requested
//! project, refuses revision rollbacks, and only then replaces its cached copy. Any
//! failure keeps the last good document.
//!
//! The agent never resolves policy itself (ADR-0003); it applies the resolved document.
//! Unknown settings keys are ignored for forward compatibility; missing keys take the
//! documented defaults; numeric values are clamped to their documented ranges.

use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use chrono::{DateTime, Datelike, NaiveTime, TimeDelta, Utc, Weekday};
use chrono_tz::Tz;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Why a policy document was not accepted.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PolicyError {
    /// `payload_b64` or `signature_b64` is not valid base64.
    #[error("invalid base64 in signed policy")]
    Base64,
    /// The signature is not 64 bytes.
    #[error("malformed signature")]
    MalformedSignature,
    /// The pinned key is not a valid Ed25519 public key.
    #[error("invalid pinned public key")]
    BadPublicKey,
    /// `key_id` does not match the pinned key.
    #[error("unknown signing key id {0:?}")]
    UnknownKey(String),
    /// The signature does not verify.
    #[error("signature verification failed")]
    InvalidSignature,
    /// The verified payload is not a valid policy document.
    #[error("invalid policy document: {0}")]
    Invalid(String),
    /// The document is for a different organization or device.
    #[error("policy document is for another device")]
    WrongDevice,
    /// The document is for a different project than requested.
    #[error("policy document is for another project")]
    WrongProject,
    /// The document's revision is older than the cached one.
    #[error("policy revision {received} is older than cached {cached}")]
    Rollback {
        /// Cached revision.
        cached: i64,
        /// Received revision.
        received: i64,
    },
}

/// `screenshots.employee_deletion`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmployeeDeletion {
    /// Employees delete their own screenshots without review.
    #[default]
    SelfService,
    /// Deletions are reviewed by an org admin.
    Review,
}

/// `session.*` settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SessionSettings {
    /// `session.allow_overlapping_sessions` (default `false`).
    pub allow_overlapping_sessions: bool,
    /// `session.require_project` (default `false`).
    pub require_project: bool,
}

/// `idle.*` settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IdleSettings {
    /// `idle.threshold_seconds` (60–1800, default 300).
    pub threshold_seconds: u32,
    /// `idle.prompt_on_return` (default `true`): when the person comes back from an idle
    /// run, ask whether to keep, remove or move that time. `false` never asks and never
    /// sends `idle.decision.v1` (the idle time is kept). Older documents without the
    /// field keep the default.
    pub prompt_on_return: bool,
}

impl Default for IdleSettings {
    fn default() -> Self {
        Self {
            threshold_seconds: 300,
            prompt_on_return: true,
        }
    }
}

/// `apps.*` settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppsSettings {
    /// `apps.capture_app_name` (default `true`). `false` disables app usage entirely.
    pub capture_app_name: bool,
    /// `apps.capture_domains` (default `false`). This agent never collects domains.
    pub capture_domains: bool,
    /// `apps.capture_window_titles` (reserved; never implemented by this agent).
    pub capture_window_titles: bool,
}

impl Default for AppsSettings {
    fn default() -> Self {
        Self {
            capture_app_name: true,
            capture_domains: false,
            capture_window_titles: false,
        }
    }
}

/// `screenshots.*` settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScreenshotSettings {
    /// `screenshots.enabled` (default `false`).
    pub enabled: bool,
    /// `screenshots.interval_minutes` (10–60, default 15).
    pub interval_minutes: u32,
    /// `screenshots.primary_monitor_only` (default `true`).
    pub primary_monitor_only: bool,
    /// `screenshots.max_width_px` (640–1920, default 1280).
    pub max_width_px: u32,
    /// `screenshots.excluded_apps` (default empty): app identifiers or names.
    pub excluded_apps: Vec<String>,
    /// `screenshots.employee_deletion` (default `self_service`).
    pub employee_deletion: EmployeeDeletion,
}

impl Default for ScreenshotSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 15,
            primary_monitor_only: true,
            max_width_px: 1280,
            excluded_apps: Vec::new(),
            employee_deletion: EmployeeDeletion::SelfService,
        }
    }
}

impl ScreenshotSettings {
    /// `true` if the app (by identifier or display name, case-insensitive) is excluded.
    pub fn is_excluded(&self, app_identifier: &str, app_name: &str) -> bool {
        self.excluded_apps.iter().any(|e| {
            let e = e.trim();
            !e.is_empty()
                && (e.eq_ignore_ascii_case(app_identifier) || e.eq_ignore_ascii_case(app_name))
        })
    }
}

/// `viewers.*` settings (enforced server-side; carried for display).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewerSettings {
    /// `viewers.manager_can_view_activity` (default `true`).
    pub manager_can_view_activity: bool,
    /// `viewers.manager_can_view_apps` (default `true`).
    pub manager_can_view_apps: bool,
    /// `viewers.manager_can_view_screenshots` (default `false`).
    pub manager_can_view_screenshots: bool,
}

impl Default for ViewerSettings {
    fn default() -> Self {
        Self {
            manager_can_view_activity: true,
            manager_can_view_apps: true,
            manager_can_view_screenshots: false,
        }
    }
}

/// `retention.*` settings (enforced server-side).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetentionSettings {
    /// `retention.screenshot_days` (1–90, default 30).
    pub screenshot_days: u32,
    /// `retention.activity_days` (7–365, default 90).
    pub activity_days: u32,
    /// `retention.app_usage_days` (7–365, default 90).
    pub app_usage_days: u32,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            screenshot_days: 30,
            activity_days: 90,
            app_usage_days: 90,
        }
    }
}

/// `offline.*` settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct OfflineSettings {
    /// `offline.max_screenshot_buffer_mb` (default 50). Unused: screenshots are never
    /// buffered offline.
    pub max_screenshot_buffer_mb: u32,
    /// `offline.metadata_buffer_days` (default 7): outbox age cap for activity/app events.
    pub metadata_buffer_days: u32,
}

impl Default for OfflineSettings {
    fn default() -> Self {
        Self {
            max_screenshot_buffer_mb: 50,
            metadata_buffer_days: 7,
        }
    }
}

/// A day reference in `work_hours.days`: ISO weekday number (1 = Monday … 7 = Sunday)
/// or a name (`"mon"`, `"monday"`, case-insensitive).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DayRef {
    /// ISO weekday number.
    Number(u8),
    /// Day name.
    Name(String),
}

impl DayRef {
    fn weekday(&self) -> Option<Weekday> {
        match self {
            DayRef::Number(n) => match n {
                1 => Some(Weekday::Mon),
                2 => Some(Weekday::Tue),
                3 => Some(Weekday::Wed),
                4 => Some(Weekday::Thu),
                5 => Some(Weekday::Fri),
                6 => Some(Weekday::Sat),
                7 => Some(Weekday::Sun),
                _ => None,
            },
            DayRef::Name(s) => s.trim().parse::<Weekday>().ok(),
        }
    }
}

/// `work_hours`: capture only happens inside this weekly window.
///
/// ```json
/// {"timezone": "Europe/Riga", "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00"}
/// ```
///
/// `start`/`end` are local `HH:MM`. `end <= start` means the window crosses midnight
/// (it belongs to the day it starts on); `start == end` means the whole day. Missing
/// or empty `days` means every day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkHours {
    /// IANA time zone name.
    pub timezone: String,
    /// Days the window opens on.
    #[serde(default)]
    pub days: Vec<DayRef>,
    /// Local start time `HH:MM`.
    pub start: String,
    /// Local end time `HH:MM`.
    pub end: String,
}

/// Parsed, validated [`WorkHours`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkWindow {
    tz: Tz,
    days: [bool; 7],
    start: NaiveTime,
    end: NaiveTime,
}

fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(s.trim(), "%H:%M:%S"))
        .ok()
}

impl WorkHours {
    /// Validates and parses the window.
    pub fn parse(&self) -> Result<WorkWindow, PolicyError> {
        let tz: Tz = self
            .timezone
            .trim()
            .parse()
            .map_err(|_| PolicyError::Invalid("work_hours.timezone".into()))?;
        let start = parse_hhmm(&self.start)
            .ok_or_else(|| PolicyError::Invalid("work_hours.start".into()))?;
        let end =
            parse_hhmm(&self.end).ok_or_else(|| PolicyError::Invalid("work_hours.end".into()))?;
        let mut days = [self.days.is_empty(); 7];
        for d in &self.days {
            let wd = d
                .weekday()
                .ok_or_else(|| PolicyError::Invalid("work_hours.days".into()))?;
            days[wd.num_days_from_monday() as usize] = true;
        }
        Ok(WorkWindow {
            tz,
            days,
            start,
            end,
        })
    }
}

impl WorkWindow {
    fn day_on(&self, wd: Weekday) -> bool {
        self.days[wd.num_days_from_monday() as usize]
    }

    /// `true` if `now` is inside the window.
    pub fn contains(&self, now: DateTime<Utc>) -> bool {
        let local = now.with_timezone(&self.tz);
        let t = local.time();
        let today = local.weekday();
        if self.start == self.end {
            return self.day_on(today);
        }
        if self.start < self.end {
            return self.day_on(today) && t >= self.start && t < self.end;
        }
        // Overnight window.
        (self.day_on(today) && t >= self.start) || (self.day_on(today.pred()) && t < self.end)
    }
}

/// The resolved settings document (`settings` in the signed payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PolicySettings {
    /// `session.*`
    pub session: SessionSettings,
    /// `idle.*`
    pub idle: IdleSettings,
    /// `apps.*`
    pub apps: AppsSettings,
    /// `screenshots.*`
    pub screenshots: ScreenshotSettings,
    /// `viewers.*`
    pub viewers: ViewerSettings,
    /// `work_hours` (`null` = no limit).
    pub work_hours: Option<WorkHours>,
    /// `retention.*`
    pub retention: RetentionSettings,
    /// `offline.*`
    pub offline: OfflineSettings,
}

impl PolicySettings {
    /// Clamps numeric fields to their documented ranges and validates `work_hours`.
    pub fn normalized(mut self) -> Result<Self, PolicyError> {
        self.idle.threshold_seconds = self.idle.threshold_seconds.clamp(60, 1800);
        let s = &mut self.screenshots;
        s.interval_minutes = s.interval_minutes.clamp(10, 60);
        s.max_width_px = s.max_width_px.clamp(640, 1920);
        let r = &mut self.retention;
        r.screenshot_days = r.screenshot_days.clamp(1, 90);
        r.activity_days = r.activity_days.clamp(7, 365);
        r.app_usage_days = r.app_usage_days.clamp(7, 365);
        self.offline.metadata_buffer_days = self.offline.metadata_buffer_days.clamp(1, 365);
        if let Some(wh) = &self.work_hours {
            wh.parse()?;
        }
        Ok(self)
    }

    /// The parsed work-hours window, if any.
    pub fn work_window(&self) -> Option<WorkWindow> {
        self.work_hours.as_ref().and_then(|w| w.parse().ok())
    }

    /// `true` if capture is allowed at `now` by `work_hours`.
    pub fn within_work_hours(&self, now: DateTime<Utc>) -> bool {
        match &self.work_hours {
            None => true,
            // A window that fails to parse never got past `normalized`; be safe anyway.
            Some(w) => w.parse().map(|w| w.contains(now)).unwrap_or(false),
        }
    }

    /// Screenshot interval as a duration.
    pub fn screenshot_interval(&self) -> TimeDelta {
        TimeDelta::minutes(i64::from(self.screenshots.interval_minutes))
    }
}

/// The signed payload: `{organization_id, user_id, device_id, project_id, revision,
/// issued_at, settings}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDocument {
    /// Organization.
    pub organization_id: String,
    /// User the device belongs to.
    pub user_id: String,
    /// Device the document was issued to.
    pub device_id: String,
    /// Project the document was resolved for (`null` = base policy).
    #[serde(default)]
    pub project_id: Option<String>,
    /// Organization policy revision.
    pub revision: i64,
    /// When the document was issued.
    #[serde(with = "crate::ts")]
    pub issued_at: DateTime<Utc>,
    /// Resolved settings.
    pub settings: PolicySettings,
}

/// Wire form of a signed policy (`GET /v1/device/policy` response).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedPolicy {
    /// Base64 of the exact UTF-8 JSON payload bytes.
    pub payload_b64: String,
    /// Base64 Ed25519 signature over those bytes.
    pub signature_b64: String,
    /// Identifier of the signing key.
    pub key_id: String,
}

/// The policy signing key pinned at enrollment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedKey {
    /// Key identifier.
    pub key_id: String,
    /// Base64 of the 32-byte Ed25519 public key.
    pub public_key_b64: String,
}

/// Decodes standard or URL-safe base64, with or without padding.
pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    let s = s.trim();
    [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
        .iter()
        .find_map(|e| e.decode(s).ok())
}

impl PinnedKey {
    fn verifying_key(&self) -> Result<VerifyingKey, PolicyError> {
        let bytes = decode_b64(&self.public_key_b64).ok_or(PolicyError::BadPublicKey)?;
        let arr: [u8; 32] = bytes.try_into().map_err(|_| PolicyError::BadPublicKey)?;
        VerifyingKey::from_bytes(&arr).map_err(|_| PolicyError::BadPublicKey)
    }

    /// Verifies the signature over the exact payload bytes, then parses and normalises
    /// the document. Nothing is parsed before the signature checks out.
    pub fn verify(&self, signed: &SignedPolicy) -> Result<PolicyDocument, PolicyError> {
        if signed.key_id != self.key_id {
            return Err(PolicyError::UnknownKey(signed.key_id.clone()));
        }
        let key = self.verifying_key()?;
        let payload = decode_b64(&signed.payload_b64).ok_or(PolicyError::Base64)?;
        let sig = decode_b64(&signed.signature_b64).ok_or(PolicyError::Base64)?;
        let sig = Signature::from_slice(&sig).map_err(|_| PolicyError::MalformedSignature)?;
        key.verify_strict(&payload, &sig)
            .map_err(|_| PolicyError::InvalidSignature)?;
        let mut doc: PolicyDocument =
            serde_json::from_slice(&payload).map_err(|e| PolicyError::Invalid(e.to_string()))?;
        doc.settings = doc.settings.normalized()?;
        Ok(doc)
    }
}

/// Persistent cache of the last good signed document per project.
pub trait PolicyCache {
    /// Loads the cached document for `project_key` (`""` = base policy).
    fn load(&self, project_key: &str) -> Option<SignedPolicy>;
    /// Stores the document for `project_key`.
    fn save(&mut self, project_key: &str, signed: &SignedPolicy);
}

/// In-memory [`PolicyCache`] (tests, or when persistence is unavailable).
#[derive(Debug, Default, Clone)]
pub struct MemoryPolicyCache(pub HashMap<String, SignedPolicy>);

impl PolicyCache for MemoryPolicyCache {
    fn load(&self, project_key: &str) -> Option<SignedPolicy> {
        self.0.get(project_key).cloned()
    }
    fn save(&mut self, project_key: &str, signed: &SignedPolicy) {
        self.0.insert(project_key.to_owned(), signed.clone());
    }
}

/// Where the effective policy came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicySource {
    /// A verified document for exactly this project (or the base, when no project).
    Exact,
    /// No document for the project: the base policy with screenshots forced off.
    BaseFallback,
    /// No document at all: built-in defaults (screenshots off).
    Defaults,
}

/// The settings the agent applies right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectivePolicy {
    /// Revision to stamp into `policy_version` (0 when running on defaults).
    pub revision: i64,
    /// Settings.
    pub settings: PolicySettings,
    /// Provenance.
    pub source: PolicySource,
}

/// Verifies, caches and serves policy documents.
pub struct PolicyStore {
    key: PinnedKey,
    organization_id: String,
    device_id: String,
    docs: HashMap<String, PolicyDocument>,
    loaded: HashSet<String>,
    cache: Box<dyn PolicyCache + Send>,
}

impl std::fmt::Debug for PolicyStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolicyStore")
            .field("key_id", &self.key.key_id)
            .field("projects", &self.docs.keys().collect::<Vec<_>>())
            .finish()
    }
}

fn project_key(project: Option<&str>) -> String {
    project.unwrap_or_default().to_owned()
}

impl PolicyStore {
    /// Creates a store for this device.
    pub fn new(
        key: PinnedKey,
        organization_id: impl Into<String>,
        device_id: impl Into<String>,
        cache: Box<dyn PolicyCache + Send>,
    ) -> Self {
        Self {
            key,
            organization_id: organization_id.into(),
            device_id: device_id.into(),
            docs: HashMap::new(),
            loaded: HashSet::new(),
            cache,
        }
    }

    fn check(&self, doc: &PolicyDocument, project: Option<&str>) -> Result<(), PolicyError> {
        if doc.device_id != self.device_id || doc.organization_id != self.organization_id {
            return Err(PolicyError::WrongDevice);
        }
        if doc.project_id.as_deref() != project {
            return Err(PolicyError::WrongProject);
        }
        Ok(())
    }

    fn ensure_loaded(&mut self, project: Option<&str>) {
        let k = project_key(project);
        if !self.loaded.insert(k.clone()) {
            return;
        }
        let Some(signed) = self.cache.load(&k) else {
            return;
        };
        match self
            .key
            .verify(&signed)
            .and_then(|d| self.check(&d, project).map(|_| d))
        {
            Ok(doc) => {
                self.docs.insert(k, doc);
            }
            Err(e) => log::warn!("ignoring cached policy that no longer verifies: {e}"),
        }
    }

    /// Verifies and applies a document fetched for `project`. On error the previous
    /// document (if any) stays in force.
    pub fn apply(
        &mut self,
        project: Option<&str>,
        signed: &SignedPolicy,
    ) -> Result<&PolicyDocument, PolicyError> {
        self.ensure_loaded(project);
        let doc = self.key.verify(signed)?;
        self.check(&doc, project)?;
        let k = project_key(project);
        if let Some(cached) = self.docs.get(&k) {
            if doc.revision < cached.revision {
                return Err(PolicyError::Rollback {
                    cached: cached.revision,
                    received: doc.revision,
                });
            }
        }
        self.cache.save(&k, signed);
        self.docs.insert(k.clone(), doc);
        Ok(&self.docs[&k])
    }

    /// The highest revision of any document held (reported in heartbeats).
    pub fn applied_revision(&mut self) -> i64 {
        self.ensure_loaded(None);
        self.docs.values().map(|d| d.revision).max().unwrap_or(0)
    }

    /// The policy to apply for `project`.
    pub fn effective(&mut self, project: Option<&str>) -> EffectivePolicy {
        self.ensure_loaded(project);
        if let Some(doc) = self.docs.get(&project_key(project)) {
            return EffectivePolicy {
                revision: doc.revision,
                settings: doc.settings.clone(),
                source: PolicySource::Exact,
            };
        }
        self.ensure_loaded(None);
        if let Some(base) = self.docs.get("") {
            let mut settings = base.settings.clone();
            settings.screenshots.enabled = false;
            return EffectivePolicy {
                revision: base.revision,
                settings,
                source: PolicySource::BaseFallback,
            };
        }
        EffectivePolicy {
            revision: 0,
            settings: PolicySettings::default(),
            source: PolicySource::Defaults,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use chrono::TimeZone;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    pub(crate) fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub(crate) fn pinned() -> PinnedKey {
        PinnedKey {
            key_id: "k1".into(),
            public_key_b64: STANDARD.encode(signing_key().verifying_key().to_bytes()),
        }
    }

    pub(crate) fn sign(payload: &serde_json::Value) -> SignedPolicy {
        let bytes = serde_json::to_vec(payload).unwrap();
        SignedPolicy {
            payload_b64: STANDARD.encode(&bytes),
            signature_b64: STANDARD.encode(signing_key().sign(&bytes).to_bytes()),
            key_id: "k1".into(),
        }
    }

    pub(crate) fn doc(
        project: Option<&str>,
        revision: i64,
        settings: serde_json::Value,
    ) -> SignedPolicy {
        sign(&json!({
            "organization_id": "org",
            "user_id": "user",
            "device_id": "dev",
            "project_id": project,
            "revision": revision,
            "issued_at": "2026-10-28T09:00:00Z",
            "settings": settings,
        }))
    }

    fn store() -> PolicyStore {
        PolicyStore::new(
            pinned(),
            "org",
            "dev",
            Box::new(MemoryPolicyCache::default()),
        )
    }

    #[test]
    fn verifies_and_parses_full_settings_table() {
        let signed = doc(
            Some("p1"),
            12,
            json!({
                "session": {"allow_overlapping_sessions": false, "require_project": true},
                "idle": {"threshold_seconds": 120},
                "apps": {"capture_app_name": true, "capture_domains": false, "capture_window_titles": false},
                "screenshots": {"enabled": true, "interval_minutes": 20, "primary_monitor_only": true,
                                "max_width_px": 1024, "excluded_apps": ["com.bank.app"],
                                "employee_deletion": "review"},
                "viewers": {"manager_can_view_activity": true, "manager_can_view_apps": false,
                            "manager_can_view_screenshots": true},
                "work_hours": {"timezone": "Europe/Riga", "days": [1,2,3,4,5], "start": "09:00", "end": "18:00"},
                "retention": {"screenshot_days": 14, "activity_days": 60, "app_usage_days": 30},
                "offline": {"max_screenshot_buffer_mb": 10, "metadata_buffer_days": 3},
                "some_future_field": {"x": 1}
            }),
        );
        let d = pinned().verify(&signed).unwrap();
        assert_eq!(d.revision, 12);
        let s = &d.settings;
        assert!(s.session.require_project);
        assert_eq!(s.idle.threshold_seconds, 120);
        assert!(s.idle.prompt_on_return, "absent → default true");
        assert!(s.screenshots.enabled);
        assert_eq!(s.screenshots.interval_minutes, 20);
        assert_eq!(s.screenshots.max_width_px, 1024);
        assert_eq!(s.screenshots.employee_deletion, EmployeeDeletion::Review);
        assert!(s.screenshots.is_excluded("COM.BANK.APP", "Bank"));
        assert!(!s.viewers.manager_can_view_apps);
        assert_eq!(s.retention.screenshot_days, 14);
        assert_eq!(s.offline.metadata_buffer_days, 3);
        assert!(s.work_hours.is_some());
    }

    #[test]
    fn missing_fields_default_and_out_of_range_values_clamp() {
        let d = pinned()
            .verify(&doc(None, 1, json!({"idle": {"threshold_seconds": 5},
                                         "screenshots": {"interval_minutes": 1, "max_width_px": 99999}})))
            .unwrap();
        assert_eq!(d.settings.idle.threshold_seconds, 60);
        assert_eq!(d.settings.screenshots.interval_minutes, 10);
        assert_eq!(d.settings.screenshots.max_width_px, 1920);
        assert!(!d.settings.screenshots.enabled);
        assert!(d.settings.apps.capture_app_name);
        assert!(d.settings.work_hours.is_none());
        assert_eq!(d.settings.retention, RetentionSettings::default());
    }

    #[test]
    fn idle_prompt_on_return_defaults_to_true_and_can_be_turned_off() {
        // Older documents (and older cached copies) have no `prompt_on_return`.
        let d = pinned()
            .verify(&doc(None, 1, json!({"idle": {"threshold_seconds": 300}})))
            .unwrap();
        assert!(d.settings.idle.prompt_on_return);
        assert!(PolicySettings::default().idle.prompt_on_return);
        let d = pinned()
            .verify(&doc(None, 2, json!({"idle": {"prompt_on_return": false}})))
            .unwrap();
        assert!(!d.settings.idle.prompt_on_return);
        assert_eq!(d.settings.idle.threshold_seconds, 300);
    }

    #[test]
    fn rejects_tampering_wrong_key_and_garbage() {
        let good = doc(None, 1, json!({}));
        let k = pinned();

        let mut tampered = good.clone();
        let mut bytes = decode_b64(&tampered.payload_b64).unwrap();
        let pos = bytes.len() - 3;
        bytes[pos] ^= 1;
        tampered.payload_b64 = STANDARD.encode(bytes);
        assert_eq!(k.verify(&tampered), Err(PolicyError::InvalidSignature));

        let mut wrong_id = good.clone();
        wrong_id.key_id = "k2".into();
        assert!(matches!(
            k.verify(&wrong_id),
            Err(PolicyError::UnknownKey(_))
        ));

        let other = SigningKey::from_bytes(&[9u8; 32]);
        let bytes = decode_b64(&good.payload_b64).unwrap();
        let mut forged = good.clone();
        forged.signature_b64 = STANDARD.encode(other.sign(&bytes).to_bytes());
        assert_eq!(k.verify(&forged), Err(PolicyError::InvalidSignature));

        let mut garbage = good.clone();
        garbage.signature_b64 = "!!!".into();
        assert_eq!(k.verify(&garbage), Err(PolicyError::Base64));
        garbage.signature_b64 = STANDARD.encode([1u8; 10]);
        assert_eq!(k.verify(&garbage), Err(PolicyError::MalformedSignature));

        // Correctly signed but not a policy document.
        assert!(matches!(
            k.verify(&sign(&json!({"hello": "world"}))),
            Err(PolicyError::Invalid(_))
        ));
        // Correctly signed, invalid time zone.
        assert!(matches!(
            k.verify(&doc(
                None,
                1,
                json!({"work_hours": {"timezone": "Mars/Base", "start": "09:00", "end": "17:00"}})
            )),
            Err(PolicyError::Invalid(_))
        ));
    }

    #[test]
    fn failure_keeps_last_good_policy() {
        let mut st = store();
        st.apply(
            None,
            &doc(None, 3, json!({"idle": {"threshold_seconds": 600}})),
        )
        .unwrap();
        let mut bad = doc(None, 4, json!({"idle": {"threshold_seconds": 60}}));
        bad.signature_b64 = doc(None, 5, json!({})).signature_b64;
        assert!(st.apply(None, &bad).is_err());
        let eff = st.effective(None);
        assert_eq!(eff.revision, 3);
        assert_eq!(eff.settings.idle.threshold_seconds, 600);

        // Rollback is refused, too.
        assert_eq!(
            st.apply(None, &doc(None, 2, json!({}))).unwrap_err(),
            PolicyError::Rollback {
                cached: 3,
                received: 2
            }
        );
        assert_eq!(st.effective(None).revision, 3);
    }

    #[test]
    fn rejects_documents_for_other_device_or_project() {
        let mut st = store();
        let other_dev = sign(&json!({
            "organization_id": "org", "user_id": "user", "device_id": "other",
            "project_id": null, "revision": 1, "issued_at": "2026-10-28T09:00:00Z", "settings": {}
        }));
        assert_eq!(
            st.apply(None, &other_dev).unwrap_err(),
            PolicyError::WrongDevice
        );
        assert_eq!(
            st.apply(Some("p1"), &doc(Some("p2"), 1, json!({})))
                .unwrap_err(),
            PolicyError::WrongProject
        );
    }

    #[test]
    fn project_without_document_uses_base_with_screenshots_off() {
        let mut st = store();
        assert_eq!(st.effective(Some("p1")).source, PolicySource::Defaults);
        st.apply(
            None,
            &doc(
                None,
                7,
                json!({"screenshots": {"enabled": true}, "idle": {"threshold_seconds": 900}}),
            ),
        )
        .unwrap();
        let eff = st.effective(Some("p1"));
        assert_eq!(eff.source, PolicySource::BaseFallback);
        assert!(!eff.settings.screenshots.enabled);
        assert_eq!(eff.settings.idle.threshold_seconds, 900);
        assert_eq!(eff.revision, 7);
        // The base itself keeps screenshots on.
        assert!(st.effective(None).settings.screenshots.enabled);

        st.apply(
            Some("p1"),
            &doc(Some("p1"), 8, json!({"screenshots": {"enabled": true}})),
        )
        .unwrap();
        let eff = st.effective(Some("p1"));
        assert_eq!(eff.source, PolicySource::Exact);
        assert!(eff.settings.screenshots.enabled);
        assert_eq!(st.applied_revision(), 8);
    }

    #[test]
    fn cache_survives_new_store_and_is_reverified() {
        let mut cache = MemoryPolicyCache::default();
        cache.save(
            "p1",
            &doc(Some("p1"), 4, json!({"screenshots": {"enabled": true}})),
        );
        let mut corrupted = doc(None, 9, json!({}));
        corrupted.payload_b64 = STANDARD.encode(b"{}");
        cache.save("", &corrupted);
        let mut st = PolicyStore::new(pinned(), "org", "dev", Box::new(cache));
        let eff = st.effective(Some("p1"));
        assert_eq!(eff.revision, 4);
        assert!(eff.settings.screenshots.enabled);
        assert_eq!(st.effective(None).source, PolicySource::Defaults);
    }

    #[test]
    fn work_hours_windows() {
        let wh = WorkHours {
            timezone: "Europe/Riga".into(), // UTC+2 in late October 2026 (after DST ends 25 Oct)
            days: vec![DayRef::Number(1), DayRef::Name("tue".into())],
            start: "09:00".into(),
            end: "18:00".into(),
        };
        let w = wh.parse().unwrap();
        // 2026-10-26 is a Monday.
        let mon = |h, m| Utc.with_ymd_and_hms(2026, 10, 26, h, m, 0).unwrap();
        assert!(!w.contains(mon(6, 59))); // 08:59 local
        assert!(w.contains(mon(7, 0))); // 09:00 local
        assert!(w.contains(mon(15, 59)));
        assert!(!w.contains(mon(16, 0))); // 18:00 local, end exclusive
        let wed = Utc.with_ymd_and_hms(2026, 10, 28, 10, 0, 0).unwrap();
        assert!(!w.contains(wed));

        let night = WorkHours {
            timezone: "UTC".into(),
            days: vec![DayRef::Number(5)],
            start: "22:00".into(),
            end: "06:00".into(),
        }
        .parse()
        .unwrap();
        // Friday 2026-10-30 23:00 and Saturday 05:59 are inside; Saturday 22:00 is not.
        assert!(night.contains(Utc.with_ymd_and_hms(2026, 10, 30, 23, 0, 0).unwrap()));
        assert!(night.contains(Utc.with_ymd_and_hms(2026, 10, 31, 5, 59, 0).unwrap()));
        assert!(!night.contains(Utc.with_ymd_and_hms(2026, 10, 31, 22, 0, 0).unwrap()));
        assert!(!night.contains(Utc.with_ymd_and_hms(2026, 10, 30, 21, 0, 0).unwrap()));

        let all_day = WorkHours {
            timezone: "UTC".into(),
            days: vec![],
            start: "00:00".into(),
            end: "00:00".into(),
        }
        .parse()
        .unwrap();
        assert!(all_day.contains(wed));

        let s = PolicySettings::default();
        assert!(s.within_work_hours(wed));
    }
}
