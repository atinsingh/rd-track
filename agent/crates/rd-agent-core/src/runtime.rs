//! The agent runtime: [`Agent`] (deterministic tick logic) and [`Runtime`] (the 1 Hz
//! loop plus a network thread).
//!
//! [`Agent`] owns the session machine and all collectors and is driven by explicit calls
//! (`start`, `pause`, `resume`, `stop`, `tick`), so tests can run it against a
//! [`FakeClock`](crate::clock::FakeClock) with no threads or network.
//!
//! [`Runtime`] runs the tick loop on the calling thread and moves every network call —
//! sync, heartbeat, policy refresh, screenshot upload — to a worker thread, so a slow
//! network can never delay a tick (which would otherwise look like a suspend) or delay
//! a stop. Commands and network events arrive on one channel and are handled between
//! ticks, immediately (a stop is applied within milliseconds, not at the next tick).

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, TimeDelta, Utc};
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::activity::{ActivityAggregator, IdleRun};
use crate::api::{
    ApiClient, ApiError, HeartbeatRequest, LicenseBlock, LicenseInfo, ScheduleToday, WorkLimits,
};
use crate::apps::AppTracker;
use crate::clock::{Clock, ClockReading, TickKind, TickObserver};
use crate::events::{
    ActivityBucket, DataGap, DataQuality, EventBody, GapReason, IdleDecision, IdleDecisionPayload,
    PauseReason, SessionStopped, StopReason, MAX_IDLE_SPAN_SECONDS,
};
use crate::identity::DeviceIdentity;
use crate::limits::{LimitScope, LimitState, LimitSummary, LIMITS_REFRESH};
use crate::outbox::{lock, NewEvent, OutboxConfig, OutboxPolicyCache, SharedOutbox};
use crate::platform::{
    secret_names, CredentialStore, ForegroundApp, ForegroundAppInfo, HttpTransport, InputCounter,
    Permissions, ScreenCapturer,
};
use crate::policy::{EffectivePolicy, PolicySettings, PolicySource, PolicyStore, SignedPolicy};
use crate::reminders::{
    self, HoursSource, ReminderChoice, ReminderInput, ReminderKind, ReminderSettings,
    ReminderState, ReminderStep, ReminderWindow, Tracking, SCHEDULE_REFRESH,
};
use crate::screenshot::{
    run_job, GateController, ScreenshotJob, ScreenshotOutcome, ScreenshotScheduler, ScreenshotSink,
    SlotDecision,
};
use crate::state::{SessionInfo, SessionMachine, SessionState, TransitionError};
use crate::sync::{SyncError, Syncer};

/// Outbox metadata key holding the open-session snapshot (crash recovery).
pub const META_SESSION: &str = "session_snapshot";
/// Outbox metadata key holding the latest [`AgentStatus`].
pub const META_AGENT_STATUS: &str = "agent_status";
/// Outbox metadata key holding the latest [`SyncStatus`].
pub const META_SYNC_STATUS: &str = "sync_status";
/// Outbox metadata key holding the active [`LicenseBlock`], if any (survives restarts).
pub const META_LICENSE_BLOCK: &str = "license_block";
/// Outbox metadata key holding [`TodayTotals`] (tray "Today" line).
pub const META_TODAY: &str = "today_totals";
/// Outbox metadata key holding the work-limit [`LimitState`] (Stage 4 F4: last good
/// copy, the sessions it leaves out, warnings already shown).
pub const META_LIMITS: &str = "work_limits";
/// Outbox metadata key holding the [`ReminderState`] (Stage 4 F3: the employee's
/// settings, today's schedule, reminders already shown).
pub const META_REMINDERS: &str = "reminders";

/// Runtime error.
#[derive(Debug, Error)]
pub enum AgentError {
    /// Illegal state transition.
    #[error(transparent)]
    Transition(#[from] TransitionError),
    /// The policy requires a project and none was given.
    #[error("the policy requires a project for every session")]
    ProjectRequired,
    /// The device was revoked; the agent no longer collects anything.
    #[error("this device has been revoked")]
    Revoked,
    /// The organization's subscription or the user's seat is not available.
    #[error("{}", .0.message())]
    LicenseUnavailable(LicenseBlock),
    /// Local storage error.
    #[error(transparent)]
    Outbox(#[from] crate::outbox::OutboxError),
    /// Moving idle time to another project needs that project.
    #[error("choose the project to move this time to")]
    IdleProjectRequired,
    /// Reminder settings that cannot be used (shown to the person).
    #[error("{0}")]
    InvalidReminderSettings(&'static str),
}

/// What to do with a session that was open when the agent last stopped running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Emit `session.stopped.v1 {reason: shutdown}` at the last time the agent was seen.
    StopAtLastSeen,
    /// Resume (emitting `data_gap.v1 {reason: offline_agent_stopped}`) if the agent was
    /// down for at most this long; otherwise stop at the last time it was seen.
    ResumeWithin(Duration),
}

/// Static agent configuration.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// Enrollment data.
    pub identity: DeviceIdentity,
    /// Tick length (1 s in production).
    pub tick: Duration,
    /// Crash-recovery behaviour.
    pub recovery: Recovery,
    /// The zone "my hours" (reminders) are in; `None` = the system's local zone.
    pub time_zone: Option<chrono_tz::Tz>,
}

impl AgentConfig {
    /// Production defaults: 1 s tick, resume a session after ≤ 10 minutes of downtime,
    /// the system's local zone.
    pub fn new(identity: DeviceIdentity) -> Self {
        Self {
            identity,
            tick: Duration::from_secs(1),
            recovery: Recovery::ResumeWithin(Duration::from_secs(600)),
            time_zone: None,
        }
    }
}

/// Collaborators of an [`Agent`].
pub struct AgentDeps {
    /// Clock.
    pub clock: Arc<dyn Clock>,
    /// Input counter.
    pub input: Box<dyn InputCounter>,
    /// Foreground app source.
    pub foreground: Box<dyn ForegroundApp>,
    /// Shared outbox.
    pub outbox: SharedOutbox,
    /// Where screenshot jobs go.
    pub screenshots: Box<dyn ScreenshotSink>,
    /// Randomness (screenshot slots).
    pub rng: StdRng,
}

/// Something the employee should be told (the UI shows it; headless mode logs it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Notice {
    /// The server rejected the session start because another session is active.
    SessionOverlap {
        /// The rejected session.
        session_id: Uuid,
    },
    /// The device was revoked; collection stopped and local data was wiped.
    Revoked,
    /// The session was paused automatically because the work-hours window ended.
    OutsideWorkHours,
    /// The server refused service (`subscription_inactive` / `seat_unavailable`); the
    /// session was stopped and collection is off until the licence is restored.
    LicenseUnavailable {
        /// Why.
        block: LicenseBlock,
    },
    /// A heartbeat succeeded again after a licence refusal; tracking is available.
    LicenseRestored,
    /// A session left open by a previous run was resumed or closed.
    Recovered {
        /// The session.
        session_id: Uuid,
        /// `true` if resumed, `false` if stopped at the last time the agent was seen.
        resumed: bool,
    },
    /// The person came back from an idle run (Stage 4 F1): ask whether to keep, remove
    /// or move that time, then answer with [`Command::ResolveIdle`] using `id`. The
    /// pending prompt is also in [`LiveStatus::idle_prompt`] until it is answered or
    /// replaced by a newer run (an unanswered prompt counts as keep; nothing is sent).
    IdleReturn {
        /// Prompt id ([`IdlePrompt::id`]).
        id: Uuid,
        /// First second of the idle run.
        #[serde(with = "crate::ts")]
        started_at: DateTime<Utc>,
        /// When the person came back.
        #[serde(with = "crate::ts")]
        ended_at: DateTime<Utc>,
        /// Idle seconds in the run.
        seconds: u32,
        /// The session's project (`None` = no project).
        project_id: Option<String>,
    },
    /// Time worked reached 80% or 100% of a daily or weekly work limit (Stage 4 F4). A
    /// heads-up only: tracking carries on, and nothing is sent anywhere. Raised once per
    /// threshold and period, only while a session is `Active`.
    LimitWarning {
        /// Stable id, e.g. `daily:2026-10-28:80`.
        id: String,
        /// Which limit.
        scope: LimitScope,
        /// `80` or `100`.
        percent: u8,
        /// The limit.
        limit_minutes: u32,
        /// Worked so far (all of the person's devices plus this session).
        worked_seconds: u64,
    },
    /// A start / stop / "still tracking?" reminder (Stage 4 F3). It is also in
    /// [`LiveStatus::reminder`] until answered with [`Command::ResolveReminder`] or
    /// withdrawn; never raised while a session is paused.
    Reminder {
        /// [`ReminderPrompt::id`].
        id: Uuid,
        /// Which reminder.
        reminder: ReminderKind,
    },
}

/// The reminder being shown (at most one at a time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderPrompt {
    /// Prompt id, passed back in [`Command::ResolveReminder`].
    pub id: Uuid,
    /// Which reminder.
    pub kind: ReminderKind,
    /// Start of the hours it relates to (start and stop reminders).
    #[serde(default, with = "crate::ts::option")]
    pub hours_start: Option<DateTime<Utc>>,
    /// End of the hours it relates to.
    #[serde(with = "crate::ts")]
    pub hours_end: DateTime<Utc>,
    /// The organization's schedule or the person's own hours.
    pub source: HoursSource,
}

/// Reminder settings and today's hours, for the tray's "Reminders" section.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderStatus {
    /// The employee's settings.
    pub settings: ReminderSettings,
    /// The organization's schedule decides today's hours ("my hours" are not used).
    pub schedule_sets_hours: bool,
    /// Today's window, if today has one.
    pub window: Option<ReminderWindow>,
}

/// Something the agent wants fetched for local notices (never sends data).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataRequest {
    /// `GET /v1/device/work-limits`, leaving out the running session.
    WorkLimits {
        /// The running session.
        exclude_session_id: Option<Uuid>,
    },
    /// `GET /v1/device/schedule-today`.
    ScheduleToday,
}

/// An unanswered idle-return prompt (at most one at a time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdlePrompt {
    /// Prompt id, passed back in [`Command::ResolveIdle`].
    pub id: Uuid,
    /// The session in which the idle run happened (the decision's `session_id`).
    pub session_id: Uuid,
    /// First second of the idle run.
    #[serde(with = "crate::ts")]
    pub started_at: DateTime<Utc>,
    /// When the person came back.
    #[serde(with = "crate::ts")]
    pub ended_at: DateTime<Utc>,
    /// Idle seconds in the run.
    pub seconds: u32,
    /// The session's project (`None` = no project).
    pub project_id: Option<String>,
    /// The session's task.
    pub task_id: Option<String>,
    /// Monotonic origin of that session (for the decision's `monotonic_ms`).
    #[serde(skip)]
    mono_origin: Duration,
}

impl IdlePrompt {
    fn notice(&self) -> Notice {
        Notice::IdleReturn {
            id: self.id,
            started_at: self.started_at,
            ended_at: self.ended_at,
            seconds: self.seconds,
            project_id: self.project_id.clone(),
        }
    }
}

/// The `idle.decision.v1` payloads for a span: one per ≤ 12 h piece (the contract's
/// limit), in order, each with the same decision. Empty for an empty span.
pub fn idle_decision_payloads(
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    decision: IdleDecision,
    project_id: Option<String>,
    task_id: Option<String>,
) -> Vec<IdleDecisionPayload> {
    let max = TimeDelta::seconds(MAX_IDLE_SPAN_SECONDS);
    let (project_id, task_id) = match decision {
        IdleDecision::Reassign => (project_id, task_id),
        IdleDecision::Keep | IdleDecision::Discard => (None, None),
    };
    let mut out = Vec::new();
    let mut from = started_at;
    while from < ended_at {
        let to = (from + max).min(ended_at);
        out.push(IdleDecisionPayload {
            idle_started_at: from,
            idle_ended_at: to,
            decision,
            project_id: project_id.clone(),
            task_id: task_id.clone(),
        });
        from = to;
    }
    out
}

/// Snapshot of the agent for `rd-agent status` and the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentStatus {
    /// `idle`, `active`, `paused`, `suspended`, `stopped`.
    pub state: String,
    /// Current or last session.
    pub session_id: Option<Uuid>,
    /// Project of the session.
    pub project_id: Option<String>,
    /// Applied policy revision.
    pub policy_revision: i64,
    /// `exact`, `base_fallback`, `defaults`.
    pub policy_source: String,
    /// Whether screenshots are enabled for this session (camera badge).
    pub screenshots_enabled: bool,
    /// Effective idle threshold.
    pub idle_threshold_seconds: u32,
    /// Last known connectivity.
    pub online: bool,
    /// Set while the server refuses service for licensing reasons.
    #[serde(default)]
    pub tracking_unavailable: Option<LicenseBlock>,
    /// Employee-facing explanation when `tracking_unavailable` is set.
    #[serde(default)]
    pub tracking_unavailable_message: Option<String>,
    /// Licence state from the last heartbeat.
    #[serde(default)]
    pub license: Option<LicenseInfo>,
    /// The person's language from the last heartbeat (`fr-CA`…; `None`: the computer's).
    #[serde(default)]
    pub locale: Option<String>,
    /// Whether a heartbeat has said the language yet (until then `locale` means nothing).
    #[serde(default)]
    pub locale_known: bool,
    /// When this snapshot was written.
    #[serde(with = "crate::ts")]
    pub updated_at: DateTime<Utc>,
}

/// Snapshot of the network worker for `rd-agent status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatus {
    /// Last successful sync.
    #[serde(default, with = "crate::ts::option")]
    pub last_success_at: Option<DateTime<Utc>>,
    /// Last attempt.
    #[serde(default, with = "crate::ts::option")]
    pub last_attempt_at: Option<DateTime<Utc>>,
    /// Last error (short description, never payloads).
    #[serde(default)]
    pub last_error: Option<String>,
    /// Events accepted during this run.
    #[serde(default)]
    pub accepted_total: u64,
}

/// Tracked time on this device for one local calendar day, summed from the activity
/// buckets the agent emitted (so it lags by up to a minute). Shown as the tray's
/// "Today 6h 42m · activity 71%" line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodayTotals {
    /// Local date the totals belong to.
    pub date: Option<NaiveDate>,
    /// Σ (active + idle) seconds of every bucket.
    pub tracked_seconds: u64,
    /// Active seconds in buckets with `data_quality` `ok` / `partial`.
    pub active_seconds: u64,
    /// Idle seconds in buckets with `data_quality` `ok` / `partial`.
    pub idle_seconds: u64,
}

impl TodayTotals {
    /// Adds a bucket whose start falls on local date `date`; a new date starts over.
    pub fn add(&mut self, date: NaiveDate, b: &ActivityBucket) {
        if self.date != Some(date) {
            *self = Self {
                date: Some(date),
                ..Self::default()
            };
        }
        self.tracked_seconds += u64::from(b.active_seconds + b.idle_seconds);
        if matches!(b.data_quality, DataQuality::Ok | DataQuality::Partial) {
            self.active_seconds += u64::from(b.active_seconds);
            self.idle_seconds += u64::from(b.idle_seconds);
        }
    }

    /// The totals if they belong to `date`, else zeros for that date.
    pub fn for_date(&self, date: NaiveDate) -> Self {
        if self.date == Some(date) {
            self.clone()
        } else {
            Self {
                date: Some(date),
                ..Self::default()
            }
        }
    }

    /// Activity percentage (system design §6.3), `None` when nothing was measurable.
    pub fn activity_percent(&self) -> Option<u8> {
        crate::describe::activity_percent(self.active_seconds, self.idle_seconds)
    }
}

/// The open session, for the tray UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LiveSession {
    /// Session id.
    pub id: Uuid,
    /// `active`, `paused` or `suspended`.
    pub state: String,
    /// Why it is paused (`user`, `work_hours`), when paused.
    pub paused_reason: Option<PauseReason>,
    /// Project.
    pub project_id: Option<String>,
    /// Task.
    pub task_id: Option<String>,
    /// Wall-clock start.
    #[serde(with = "crate::ts")]
    pub started_at: DateTime<Utc>,
    /// Seconds spent `Active` in this session (paused and suspended time excluded) —
    /// the tray's elapsed timer.
    pub tracked_seconds: u64,
}

/// The policy that would apply to a session started now for `project_id` — what the
/// session-start notice lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PolicyPreview {
    /// Project (`None` = no project).
    pub project_id: Option<String>,
    /// `exact`, `base_fallback` (no document for the project yet: screenshots forced
    /// off), or `defaults`.
    pub source: String,
    /// Revision.
    pub revision: i64,
    /// Settings.
    pub settings: PolicySettings,
}

/// Everything a UI needs, published by [`Runtime`] after every tick and command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LiveStatus {
    /// Agent snapshot (state, licence, camera badge, connectivity).
    pub agent: AgentStatus,
    /// The open session, if any.
    pub session: Option<LiveSession>,
    /// Settings in force (the open session's project, else the base policy).
    pub settings: PolicySettings,
    /// Preview for the project selected with [`Command::Preview`].
    pub preview: Option<PolicyPreview>,
    /// OS permission health.
    pub permissions: Permissions,
    /// Today's tracked time on this device.
    pub today: TodayTotals,
    /// Network worker status.
    pub sync: SyncStatus,
    /// Events waiting in the outbox (refreshed every few seconds).
    pub outbox_depth: u64,
    /// The device was revoked (collection stopped, local data wiped).
    pub revoked: bool,
    /// The unanswered idle-return prompt, if any (cleared once answered).
    pub idle_prompt: Option<IdlePrompt>,
    /// Progress against the work limits (`None`: no limits, or no copy for today).
    pub limits: Option<LimitSummary>,
    /// The reminder being shown, if any.
    pub reminder: Option<ReminderPrompt>,
    /// Reminder settings and today's hours.
    pub reminders: ReminderStatus,
}

/// Receives [`LiveStatus`] snapshots and [`Notice`]s from a running [`Runtime`] (the
/// tray app). Called on the tick thread: implementations must return quickly.
pub trait RuntimeObserver: Send {
    /// A new status snapshot (at least once per tick).
    fn status(&mut self, status: &LiveStatus);
    /// Something the employee should be told.
    fn notice(&mut self, notice: &Notice);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionSnapshot {
    session_id: Uuid,
    project_id: Option<String>,
    task_id: Option<String>,
    #[serde(with = "crate::ts")]
    started_at: DateTime<Utc>,
    paused: Option<PauseReason>,
    #[serde(with = "crate::ts")]
    last_alive: DateTime<Utc>,
    last_monotonic_ms: u64,
    #[serde(default)]
    tracked_ms: u64,
}

/// What a tick did (for tests and diagnostics).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickSummary {
    /// Events queued during the tick.
    pub events: usize,
    /// A screenshot job was dispatched.
    pub screenshot_dispatched: bool,
}

/// The agent's tick logic. See the module docs.
pub struct Agent {
    cfg: AgentConfig,
    clock: Arc<dyn Clock>,
    input: Box<dyn InputCounter>,
    foreground: Box<dyn ForegroundApp>,
    outbox: SharedOutbox,
    sink: Box<dyn ScreenshotSink>,
    rng: StdRng,
    machine: SessionMachine,
    policy: PolicyStore,
    effective: EffectivePolicy,
    activity: ActivityAggregator,
    apps: AppTracker,
    scheduler: ScreenshotScheduler,
    gates: GateController,
    observer: TickObserver,
    last_capture: Option<Duration>,
    last_foreground: Option<ForegroundAppInfo>,
    online: bool,
    revoked: bool,
    license_block: Option<LicenseBlock>,
    license: Option<LicenseInfo>,
    locale: Option<String>,
    locale_known: bool,
    ticks: u64,
    queued: usize,
    notices: Vec<Notice>,
    policy_requests: Vec<Option<String>>,
    today: TodayTotals,
    session_tracked: Duration,
    idle_prompt: Option<IdlePrompt>,
    limits: LimitState,
    reminders: ReminderState,
    reminder: Option<ReminderPrompt>,
    data_requests: Vec<DataRequest>,
    last_limits_fetch: Option<Duration>,
    last_schedule_fetch: Option<(Duration, NaiveDate)>,
}

impl std::fmt::Debug for Agent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agent")
            .field("state", &self.machine.state())
            .field("policy_revision", &self.effective.revision)
            .finish()
    }
}

fn source_name(s: PolicySource) -> &'static str {
    match s {
        PolicySource::Exact => "exact",
        PolicySource::BaseFallback => "base_fallback",
        PolicySource::Defaults => "defaults",
    }
}

fn mono_ms(now: Duration, origin: Duration) -> u64 {
    u64::try_from(now.saturating_sub(origin).as_millis()).unwrap_or(u64::MAX)
}

impl Agent {
    /// Creates the agent and recovers a session left open by a previous run.
    pub fn new(cfg: AgentConfig, deps: AgentDeps) -> Result<Self, AgentError> {
        let id = &cfg.identity;
        let mut policy = PolicyStore::new(
            id.policy_signing_key.clone(),
            id.organization_id.clone(),
            id.device_id.clone(),
            Box::new(OutboxPolicyCache(deps.outbox.clone())),
        );
        let effective = policy.effective(None);
        let tolerance = TimeDelta::from_std(cfg.tick * 2).unwrap_or(TimeDelta::seconds(2));
        let mut agent = Self {
            clock: deps.clock,
            input: deps.input,
            foreground: deps.foreground,
            outbox: deps.outbox,
            sink: deps.screenshots,
            rng: deps.rng,
            machine: SessionMachine::new(),
            activity: ActivityAggregator::new(effective.settings.idle.threshold_seconds),
            apps: AppTracker::new(),
            scheduler: ScreenshotScheduler::new(
                effective.settings.screenshot_interval(),
                tolerance,
            ),
            gates: GateController::new(),
            observer: TickObserver::new(cfg.tick),
            last_capture: None,
            last_foreground: None,
            online: true,
            revoked: false,
            license_block: None,
            license: None,
            locale: None,
            locale_known: false,
            ticks: 0,
            queued: 0,
            notices: Vec::new(),
            policy_requests: vec![None],
            today: TodayTotals::default(),
            session_tracked: Duration::ZERO,
            idle_prompt: None,
            limits: LimitState::default(),
            reminders: ReminderState::default(),
            reminder: None,
            data_requests: Vec::new(),
            last_limits_fetch: None,
            last_schedule_fetch: None,
            effective,
            policy,
            cfg,
        };
        agent.input.set_capturing(false);
        agent.apply_effective();
        agent.license_block = lock(&agent.outbox)
            .get_meta(META_LICENSE_BLOCK)?
            .and_then(|s| serde_json::from_str(&s).ok());
        agent.today = lock(&agent.outbox)
            .get_meta(META_TODAY)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        agent.limits = agent.load_meta(META_LIMITS)?;
        agent.reminders = agent.load_meta(META_REMINDERS)?;
        agent.recover()?;
        if let Some(block) = agent.license_block {
            // Still refused from a previous run: never resume capture.
            if agent.machine.is_open() {
                let _ = agent.stop(StopReason::Policy);
            }
            agent.notices.push(Notice::LicenseUnavailable { block });
        }
        agent.write_status();
        Ok(agent)
    }

    // ----- accessors ---------------------------------------------------------------

    /// Current session state.
    pub fn state(&self) -> SessionState {
        self.machine.state()
    }

    /// Current (or last) session.
    pub fn session(&self) -> Option<&SessionInfo> {
        self.machine.session()
    }

    /// The policy in force.
    pub fn effective_policy(&self) -> &EffectivePolicy {
        &self.effective
    }

    /// Highest applied policy revision (heartbeat `applied_policy_revision`).
    pub fn applied_policy_revision(&mut self) -> i64 {
        self.policy.applied_revision()
    }

    /// Project of the open session.
    pub fn current_project(&self) -> Option<String> {
        self.machine
            .is_open()
            .then(|| self.machine.session().and_then(|s| s.project_id.clone()))
            .flatten()
    }

    /// OS permission status.
    pub fn permissions(&self, capturer: Option<&dyn ScreenCapturer>) -> Permissions {
        Permissions {
            input_monitoring: self.input.permission(),
            screen_recording: capturer.map(|c| c.permission()).unwrap_or_default(),
            accessibility: self.foreground.permission(),
        }
    }

    /// The open session for the UI (`None` when idle or stopped).
    pub fn live_session(&self) -> Option<LiveSession> {
        if !self.machine.is_open() {
            return None;
        }
        let s = self.machine.session()?;
        Some(LiveSession {
            id: s.id,
            state: self.machine.state().name().to_owned(),
            paused_reason: match self.machine.state() {
                SessionState::Paused(r) => Some(r),
                _ => None,
            },
            project_id: s.project_id.clone(),
            task_id: s.task_id.clone(),
            started_at: s.started_at,
            tracked_seconds: self.session_tracked.as_secs(),
        })
    }

    /// Today's totals on this device (local calendar day).
    pub fn today(&self) -> TodayTotals {
        self.today
            .for_date(self.clock.wall().with_timezone(&Local).date_naive())
    }

    /// The policy a session started now for `project` would run under, from the
    /// verified cache (no network). See [`Agent::request_policy`] to refresh it first.
    pub fn policy_preview(&mut self, project: Option<&str>) -> PolicyPreview {
        let e = self.policy.effective(project);
        PolicyPreview {
            project_id: project.map(str::to_owned),
            source: source_name(e.source).to_owned(),
            revision: e.revision,
            settings: e.settings,
        }
    }

    /// Asks the network thread to fetch the base policy and `project`'s policy now.
    pub fn request_policy(&mut self, project: Option<String>) {
        self.policy_requests.push(None);
        if project.is_some() {
            self.policy_requests.push(project);
        }
    }

    /// Takes user-facing notices produced since the last call.
    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    /// The unanswered idle-return prompt, if any.
    pub fn idle_prompt(&self) -> Option<&IdlePrompt> {
        self.idle_prompt.as_ref()
    }

    /// Answers the idle-return prompt `id` with the person's choice: queues
    /// `idle.decision.v1` in the outbox (so it is delivered even after going offline or
    /// restarting) for the session the run happened in, and clears the prompt. A span
    /// longer than the contract's 12 h is sent as consecutive ≤ 12 h pieces.
    ///
    /// Returns `Ok(false)` (and changes nothing) for an unknown or stale `id`.
    /// `project_id` / `task_id` are only sent with [`IdleDecision::Reassign`], which
    /// requires a project. Tracking is never affected.
    pub fn resolve_idle(
        &mut self,
        id: Uuid,
        decision: IdleDecision,
        project_id: Option<String>,
        task_id: Option<String>,
    ) -> Result<bool, AgentError> {
        if self.revoked {
            return Err(AgentError::Revoked);
        }
        if self.idle_prompt.as_ref().is_none_or(|p| p.id != id) {
            log::info!("ignoring an answer to an idle prompt that is no longer pending");
            return Ok(false);
        }
        let project_id = project_id.filter(|p| !p.is_empty());
        let task_id = task_id.filter(|t| !t.is_empty() && project_id.is_some());
        if decision == IdleDecision::Reassign && project_id.is_none() {
            return Err(AgentError::IdleProjectRequired);
        }
        let Some(p) = self.idle_prompt.take() else {
            return Ok(false);
        };
        let now = ClockReading::now(self.clock.as_ref());
        let monotonic_ms = mono_ms(now.mono, p.mono_origin);
        for payload in
            idle_decision_payloads(p.started_at, p.ended_at, decision, project_id, task_id)
        {
            self.emit_raw(
                p.session_id,
                EventBody::IdleDecision(payload),
                now.wall,
                monotonic_ms,
            );
        }
        log::info!("idle time answered: {decision:?}");
        Ok(true)
    }

    /// Takes the projects whose policy should be fetched now (`None` = base policy).
    pub fn take_policy_requests(&mut self) -> Vec<Option<String>> {
        std::mem::take(&mut self.policy_requests)
    }

    /// Takes the work-limit / schedule fetches due now.
    pub fn take_data_requests(&mut self) -> Vec<DataRequest> {
        std::mem::take(&mut self.data_requests)
    }

    /// Progress against the work limits now (`None`: no limits, or no copy for today).
    pub fn limit_summary(&self) -> Option<LimitSummary> {
        let now = self.clock.wall();
        LimitSummary::of(&self.limits.progress(
            self.running_session(),
            self.activity.unemitted_seconds(),
            now,
        ))
    }

    /// The reminder being shown, if any.
    pub fn reminder(&self) -> Option<&ReminderPrompt> {
        self.reminder.as_ref()
    }

    /// Reminder settings and today's hours.
    pub fn reminder_status(&self) -> ReminderStatus {
        let now = self.clock.wall();
        ReminderStatus {
            settings: self.reminders.settings.clone(),
            schedule_sets_hours: self
                .reminders
                .schedule
                .as_ref()
                .is_some_and(|s| s.is_current(now) && s.applies()),
            window: self.reminder_window(now),
        }
    }

    /// The person's answer to the reminder `id`. "Stop tracking" stops the session
    /// (the person's own stop); "Not today" suppresses the start reminder for the day;
    /// "Start tracking" only clears it (the tray then runs its usual start flow).
    ///
    /// Returns `Ok(false)` (and changes nothing) for an unknown or stale `id`, or a
    /// choice that does not answer that reminder.
    pub fn resolve_reminder(
        &mut self,
        id: Uuid,
        choice: ReminderChoice,
    ) -> Result<bool, AgentError> {
        if self.revoked {
            return Err(AgentError::Revoked);
        }
        let Some(p) = self.reminder.as_ref().filter(|p| p.id == id) else {
            log::info!("ignoring an answer to a reminder that is no longer shown");
            return Ok(false);
        };
        if !choice.answers(p.kind) {
            return Ok(false);
        }
        self.reminder = None;
        reminders::answer(&mut self.reminders.ledger, choice);
        self.save_meta(META_REMINDERS, &self.reminders);
        if choice == ReminderChoice::Stop && self.machine.is_open() {
            self.stop(StopReason::User)?;
        }
        Ok(true)
    }

    /// Replaces the employee's reminder settings (validated, persisted locally).
    pub fn set_reminder_settings(&mut self, settings: ReminderSettings) -> Result<(), AgentError> {
        let settings = settings
            .validated()
            .map_err(AgentError::InvalidReminderSettings)?;
        self.reminders.settings = settings;
        self.save_meta(META_REMINDERS, &self.reminders);
        log::info!("reminder settings changed");
        Ok(())
    }

    /// `true` once the device has been revoked.
    pub fn is_revoked(&self) -> bool {
        self.revoked
    }

    /// The licence refusal in force, if any.
    pub fn license_block(&self) -> Option<LicenseBlock> {
        self.license_block
    }

    /// Sets connectivity (screenshots are never attempted while offline).
    pub fn set_online(&mut self, online: bool) {
        self.online = online;
    }

    /// Status snapshot.
    pub fn status(&self) -> AgentStatus {
        AgentStatus {
            state: self.machine.state().name().to_owned(),
            session_id: self.machine.session().map(|s| s.id),
            project_id: self.machine.session().and_then(|s| s.project_id.clone()),
            policy_revision: self.effective.revision,
            policy_source: source_name(self.effective.source).to_owned(),
            screenshots_enabled: self.effective.settings.screenshots.enabled,
            idle_threshold_seconds: self.effective.settings.idle.threshold_seconds,
            online: self.online,
            tracking_unavailable: self.license_block,
            tracking_unavailable_message: self.license_block.map(|b| b.message().to_owned()),
            license: self.license.clone(),
            locale: self.locale.clone(),
            locale_known: self.locale_known,
            updated_at: self.clock.wall(),
        }
    }

    // ----- commands ----------------------------------------------------------------

    /// Starts a session (`Idle | Stopped → Active`). Returns the new session id.
    pub fn start(
        &mut self,
        project_id: Option<String>,
        task_id: Option<String>,
    ) -> Result<Uuid, AgentError> {
        if self.revoked {
            return Err(AgentError::Revoked);
        }
        if let Some(block) = self.license_block {
            return Err(AgentError::LicenseUnavailable(block));
        }
        if project_id.is_none() && self.policy.effective(None).settings.session.require_project {
            return Err(AgentError::ProjectRequired);
        }
        let now = ClockReading::now(self.clock.as_ref());
        let t = self
            .machine
            .start(project_id.clone(), task_id, now.wall, now.mono)?;
        self.effective = self.policy.effective(project_id.as_deref());
        self.activity = ActivityAggregator::new(self.effective.settings.idle.threshold_seconds);
        self.apps = AppTracker::new();
        self.scheduler.clear();
        self.session_tracked = Duration::ZERO;
        self.apply_effective();
        if let Some(ev) = t.event {
            self.emit(ev, now.wall);
        }
        self.policy_requests.push(None);
        if project_id.is_some() {
            self.policy_requests.push(project_id);
        }
        self.enter_active(now);
        let id = self.machine.session().map(|s| s.id).unwrap_or_default();
        self.limits.session_started(id, now.wall);
        self.save_meta(META_LIMITS, &self.limits);
        self.last_limits_fetch = None;
        log::info!("session started");
        if !self.effective.settings.within_work_hours(now.wall) {
            self.pause_with(PauseReason::WorkHours, now)?;
            self.notices.push(Notice::OutsideWorkHours);
        }
        self.persist_session(now);
        self.write_status();
        Ok(id)
    }

    /// Pauses the session at the employee's request.
    pub fn pause(&mut self) -> Result<(), AgentError> {
        let now = ClockReading::now(self.clock.as_ref());
        self.pause_with(PauseReason::User, now)?;
        self.persist_session(now);
        self.write_status();
        Ok(())
    }

    /// Resumes a paused session.
    pub fn resume(&mut self) -> Result<(), AgentError> {
        if self.revoked {
            return Err(AgentError::Revoked);
        }
        if let Some(block) = self.license_block {
            return Err(AgentError::LicenseUnavailable(block));
        }
        let now = ClockReading::now(self.clock.as_ref());
        self.resume_at(now)?;
        self.last_limits_fetch = None;
        if !self.effective.settings.within_work_hours(now.wall) {
            self.pause_with(PauseReason::WorkHours, now)?;
            self.notices.push(Notice::OutsideWorkHours);
        }
        self.persist_session(now);
        self.write_status();
        Ok(())
    }

    /// Stops the session. Capture halts immediately: pending screenshot jobs are
    /// cancelled and the final partial second is flushed before `session.stopped.v1`.
    pub fn stop(&mut self, reason: StopReason) -> Result<(), AgentError> {
        let now = ClockReading::now(self.clock.as_ref());
        self.stop_at(reason, now)
    }

    fn stop_at(&mut self, reason: StopReason, now: ClockReading) -> Result<(), AgentError> {
        if !self.machine.is_open() {
            return Err(TransitionError {
                action: "stop",
                state: self.machine.state().name(),
            }
            .into());
        }
        self.gates.close_all();
        if self.machine.is_capturing() {
            self.capture_until(now);
        }
        self.input.set_capturing(false);
        self.last_capture = None;
        let buckets = self.activity.flush_all();
        let apps = self.apps.flush();
        if reason != StopReason::Revoked {
            self.emit_buckets(buckets, now.wall);
            self.emit_apps(apps, now.wall);
        }
        let t = self.machine.stop(reason)?;
        if let Some(ev) = t.event {
            self.emit(ev, now.wall);
        }
        self.scheduler.clear();
        if let Err(e) = lock(&self.outbox).delete_meta(META_SESSION) {
            log::warn!("could not clear session snapshot: {e}");
        }
        log::info!("session stopped ({reason:?})");
        self.write_status();
        Ok(())
    }

    // ----- network-driven ----------------------------------------------------------

    /// Applies a policy document fetched for `project` (`None` = base). Invalid
    /// documents are ignored and the last good one stays in force.
    pub fn on_policy(&mut self, project: Option<&str>, signed: &SignedPolicy) {
        match self.policy.apply(project, signed) {
            Ok(doc) => log::info!("applied policy revision {}", doc.revision),
            Err(e) => {
                log::warn!("rejected policy document: {e}");
                return;
            }
        }
        let current = self.current_project();
        let now = self.clock.wall();
        let before_enabled = self.effective.settings.screenshots.enabled;
        self.effective = self.policy.effective(current.as_deref());
        self.apply_effective();
        if before_enabled && !self.effective.settings.screenshots.enabled {
            self.gates.close_all();
            self.scheduler.clear();
        }
        let interval = self.effective.settings.screenshot_interval();
        self.scheduler.set_interval(interval, now, &mut self.rng);
        if !self.effective.settings.idle.prompt_on_return && self.idle_prompt.take().is_some() {
            log::info!("idle prompts were turned off; the pending idle time is kept");
        }
        self.write_status();
    }

    /// Applies fetched work limits (`None`: the plan has none) that leave out
    /// `excluded`. Warnings are checked on the next `Active` tick.
    pub fn on_work_limits(&mut self, limits: Option<WorkLimits>, excluded: Option<Uuid>) {
        self.limits.on_fetched(limits, excluded);
        self.save_meta(META_LIMITS, &self.limits);
    }

    /// Applies today's schedule (`None`: the server has no schedules, so "my hours"
    /// apply).
    pub fn on_schedule(&mut self, schedule: Option<ScheduleToday>) {
        if self.reminders.schedule != schedule {
            self.reminders.schedule = schedule;
            self.save_meta(META_REMINDERS, &self.reminders);
        }
    }

    /// Handles sessions the server rejected as overlapping: stops the local session.
    pub fn on_sessions_rejected(&mut self, sessions: &[Uuid]) {
        let Some(current) = self.machine.session().map(|s| s.id) else {
            return;
        };
        if sessions.contains(&current) && self.machine.is_open() {
            log::warn!("server rejected the session as overlapping another; stopping");
            if let Err(e) = self.stop(StopReason::Overlap) {
                log::error!("could not stop overlapping session: {e}");
            }
            self.notices.push(Notice::SessionOverlap {
                session_id: current,
            });
        }
    }

    /// `403 subscription_inactive` / `seat_unavailable`: a soft stop. The open session
    /// is stopped with `session.stopped.v1 {reason: policy}` (queued like any event),
    /// all collection stops, and new sessions are refused until
    /// [`Agent::on_license_restored`]. Unlike revocation, the outbox and credential are
    /// kept.
    pub fn on_license_blocked(&mut self, block: LicenseBlock) {
        let changed = self.license_block != Some(block);
        self.license_block = Some(block);
        self.gates.close_all();
        if self.machine.is_open() {
            if let Err(e) = self.stop(StopReason::Policy) {
                log::error!("could not stop session: {e}");
            }
        }
        self.input.set_capturing(false);
        self.scheduler.clear();
        if let Ok(json) = serde_json::to_string(&block) {
            if let Err(e) = lock(&self.outbox).set_meta(META_LICENSE_BLOCK, &json) {
                log::warn!("could not persist licence state: {e}");
            }
        }
        if changed {
            log::warn!("{}", block.message());
            self.notices.push(Notice::LicenseUnavailable { block });
        }
        self.write_status();
    }

    /// A heartbeat succeeded after a licence refusal: tracking is available again
    /// (a new session must be started; nothing resumes by itself).
    pub fn on_license_restored(&mut self) {
        if self.license_block.take().is_none() {
            return;
        }
        if let Err(e) = lock(&self.outbox).delete_meta(META_LICENSE_BLOCK) {
            log::warn!("could not clear licence state: {e}");
        }
        log::info!("licence available again; tracking can resume");
        self.notices.push(Notice::LicenseRestored);
        self.write_status();
    }

    /// Records the licence state from a heartbeat (for display only).
    pub fn on_license_info(&mut self, info: Option<LicenseInfo>) {
        if self.license != info {
            self.license = info;
            self.write_status();
        }
    }

    /// Records the person's language from a heartbeat (for display only).
    pub fn on_locale(&mut self, locale: Option<String>) {
        if self.locale != locale || !self.locale_known {
            self.locale = locale;
            self.locale_known = true;
            self.write_status();
        }
    }

    /// `401 device_revoked`: stop collecting at once (no event — the server already
    /// knows), and wipe the outbox. The caller wipes the credential.
    pub fn on_revoked(&mut self) {
        if self.revoked {
            return;
        }
        self.revoked = true;
        self.idle_prompt = None;
        self.reminder = None;
        self.gates.close_all();
        if self.machine.is_open() {
            let now = ClockReading::now(self.clock.as_ref());
            let _ = self.stop_at(StopReason::Revoked, now);
        }
        self.input.set_capturing(false);
        if let Err(e) = lock(&self.outbox).wipe() {
            log::error!("could not wipe outbox after revocation: {e}");
        }
        self.notices.push(Notice::Revoked);
        log::warn!("device revoked: collection stopped and local data wiped");
    }

    // ----- the tick ----------------------------------------------------------------

    /// One tick of the 1 Hz loop.
    pub fn tick(&mut self) -> TickSummary {
        self.queued = 0;
        let now = ClockReading::now(self.clock.as_ref());
        let kind = self.observer.observe(now);
        let mut summary = TickSummary::default();
        if self.revoked {
            return summary;
        }
        self.ticks += 1;
        match self.machine.state() {
            SessionState::Active => match kind {
                TickKind::Suspended { gap_start, gap_end } => {
                    self.on_suspend(gap_start, gap_end, now)
                }
                TickKind::ClockChange {
                    gap_start, gap_end, ..
                } => self.on_clock_change(gap_start, gap_end, now),
                TickKind::First | TickKind::Normal { .. } => {
                    if !self.effective.settings.within_work_hours(now.wall) {
                        if self.pause_with(PauseReason::WorkHours, now).is_ok() {
                            self.notices.push(Notice::OutsideWorkHours);
                            self.persist_session(now);
                        }
                    } else {
                        self.capture_until(now);
                        summary.screenshot_dispatched = self.screenshot_check(now);
                    }
                }
            },
            SessionState::Paused(reason) => {
                let buckets = self.activity.emit_completed(now.wall);
                self.emit_buckets(buckets, now.wall);
                if reason == PauseReason::WorkHours
                    && self.effective.settings.within_work_hours(now.wall)
                    && self.resume_at(now).is_ok()
                {
                    self.persist_session(now);
                }
            }
            _ => {}
        }
        self.nudges(now);
        if self.machine.is_open() && self.ticks % 10 == 0 {
            self.persist_session(now);
        }
        if self.ticks % 5 == 0 {
            self.write_status();
        }
        if self.ticks % 60 == 0 {
            if let Err(e) = lock(&self.outbox).prune(now.wall) {
                log::warn!("outbox prune failed: {e}");
            }
        }
        summary.events = self.queued;
        summary
    }

    // ----- internals ---------------------------------------------------------------

    fn apply_effective(&mut self) {
        let s = &self.effective.settings;
        self.activity.set_threshold(s.idle.threshold_seconds);
        let mut o = lock(&self.outbox);
        let cfg = OutboxConfig {
            max_age: TimeDelta::days(i64::from(s.offline.metadata_buffer_days)),
            ..o.config()
        };
        o.set_config(cfg);
    }

    fn enter_active(&mut self, now: ClockReading) {
        self.input.set_capturing(true);
        self.last_capture = Some(now.mono);
    }

    fn leave_active(&mut self, now: ClockReading) {
        self.gates.close_all();
        self.input.set_capturing(false);
        self.last_capture = None;
        let buckets = self.activity.interrupt(now.wall);
        let apps = self.apps.flush();
        self.emit_buckets(buckets, now.wall);
        self.emit_apps(apps, now.wall);
    }

    fn pause_with(&mut self, reason: PauseReason, now: ClockReading) -> Result<(), AgentError> {
        if self.machine.state() != SessionState::Active {
            return Err(TransitionError {
                action: "pause",
                state: self.machine.state().name(),
            }
            .into());
        }
        self.capture_until(now);
        self.leave_active(now);
        let t = self.machine.pause(reason)?;
        if let Some(ev) = t.event {
            self.emit(ev, now.wall);
        }
        log::info!("session paused ({reason:?})");
        Ok(())
    }

    fn resume_at(&mut self, now: ClockReading) -> Result<(), AgentError> {
        let t = self.machine.resume()?;
        if let Some(ev) = t.event {
            self.emit(ev, now.wall);
        }
        self.enter_active(now);
        log::info!("session resumed");
        Ok(())
    }

    /// Samples input and foreground for the time since the last capture point.
    fn capture_until(&mut self, now: ClockReading) {
        if !self.machine.is_capturing() {
            return;
        }
        let since = self.last_capture.unwrap_or(now.mono);
        self.last_capture = Some(now.mono);
        let elapsed = now.mono.saturating_sub(since);
        self.session_tracked += elapsed;
        let sample = self.input.sample();
        let buckets = self.activity.record(now.wall, elapsed, sample);
        self.emit_buckets(buckets, now.wall);
        for run in self.activity.take_idle_returns() {
            self.on_idle_return(run);
        }

        let s = &self.effective.settings;
        let want_apps = s.apps.capture_app_name;
        let want_fg =
            want_apps || (s.screenshots.enabled && !s.screenshots.excluded_apps.is_empty());
        self.last_foreground = if want_fg {
            self.foreground.current()
        } else {
            None
        };
        if want_apps {
            let segs = self
                .apps
                .record(now.wall, elapsed, self.last_foreground.clone());
            self.emit_apps(segs, now.wall);
        }
    }

    /// Input resumed after an idle run while the session is `Active`: prompt (unless the
    /// policy says to keep idle time without asking). A newer run replaces an unanswered
    /// prompt; the older span then simply stays as recorded (keep), with no event.
    fn on_idle_return(&mut self, run: IdleRun) {
        if !self.effective.settings.idle.prompt_on_return {
            return;
        }
        if run.ended_at <= run.started_at || run.idle_seconds == 0 {
            return;
        }
        let Some(sess) = self.machine.session() else {
            return;
        };
        let prompt = IdlePrompt {
            id: Uuid::new_v4(),
            session_id: sess.id,
            started_at: run.started_at,
            ended_at: run.ended_at,
            seconds: run.idle_seconds,
            project_id: sess.project_id.clone(),
            task_id: sess.task_id.clone(),
            mono_origin: sess.mono_origin,
        };
        if self.idle_prompt.is_some() {
            log::info!("an unanswered idle prompt was replaced by a newer one; its time is kept");
        }
        log::info!("back after {} s idle", run.idle_seconds);
        self.notices.push(prompt.notice());
        self.idle_prompt = Some(prompt);
    }

    fn on_suspend(&mut self, gap_start: DateTime<Utc>, gap_end: DateTime<Utc>, now: ClockReading) {
        log::info!("wake from sleep detected; recording a data gap");
        if self.machine.suspend().is_err() {
            return;
        }
        self.leave_active(now);
        self.emit(
            EventBody::DataGap(DataGap {
                gap_start,
                gap_end,
                reason: GapReason::Suspended,
            }),
            gap_end,
        );
        if self.machine.wake().is_ok() {
            self.enter_active(now);
        }
        self.persist_session(now);
    }

    fn on_clock_change(
        &mut self,
        gap_start: DateTime<Utc>,
        gap_end: DateTime<Utc>,
        now: ClockReading,
    ) {
        log::warn!("wall clock changed; recording a data gap");
        self.leave_active(now);
        self.emit(
            EventBody::DataGap(DataGap {
                gap_start,
                gap_end,
                reason: GapReason::ClockChange,
            }),
            now.wall,
        );
        self.enter_active(now);
        self.persist_session(now);
    }

    fn screenshot_check(&mut self, now: ClockReading) -> bool {
        let s = self.effective.settings.screenshots.clone();
        if !s.enabled {
            self.scheduler.clear();
            return false;
        }
        let interval = self.effective.settings.screenshot_interval();
        self.scheduler
            .set_interval(interval, now.wall, &mut self.rng);
        match self.scheduler.poll(now.wall, &mut self.rng) {
            SlotDecision::NotDue => false,
            SlotDecision::Missed => {
                log::debug!("screenshot slot missed (not active at slot time)");
                false
            }
            SlotDecision::Due => {
                if !self.online {
                    log::info!("screenshot slot skipped: offline");
                    return false;
                }
                if let Some(fg) = &self.last_foreground {
                    if s.is_excluded(&fg.app_identifier, &fg.app_name) {
                        log::info!("screenshot slot skipped: excluded app in foreground");
                        return false;
                    }
                }
                let Some(session_id) = self.machine.session().map(|s| s.id) else {
                    return false;
                };
                self.sink.dispatch(ScreenshotJob {
                    session_id,
                    max_width: s.max_width_px,
                    primary_monitor_only: s.primary_monitor_only,
                    gate: self.gates.gate(),
                });
                true
            }
        }
    }

    fn emit_buckets(&mut self, buckets: Vec<ActivityBucket>, now: DateTime<Utc>) {
        let any = !buckets.is_empty();
        for b in buckets {
            let end = b.bucket_start + TimeDelta::minutes(1);
            if let Some(sess) = self.machine.session() {
                let date = b.bucket_start.with_timezone(&Local).date_naive();
                self.today.add(date, &b);
                self.limits
                    .add_seconds(sess.id, u64::from(b.active_seconds + b.idle_seconds));
            }
            self.emit(EventBody::ActivityBucket(b), end.min(now));
        }
        if any {
            if let Ok(json) = serde_json::to_string(&self.today) {
                if let Err(e) = lock(&self.outbox).set_meta(META_TODAY, &json) {
                    log::debug!("could not persist today's totals: {e}");
                }
            }
            self.save_meta(META_LIMITS, &self.limits);
        }
    }

    fn emit_apps(&mut self, segs: Vec<crate::events::AppUsage>, now: DateTime<Utc>) {
        for s in segs {
            self.emit(EventBody::AppUsage(s), now);
        }
    }

    fn emit(&mut self, body: EventBody, occurred_at: DateTime<Utc>) {
        if let EventBody::DataGap(g) = &body {
            // The contract requires `gap_end > gap_start`; an empty gap carries nothing.
            if g.gap_end <= g.gap_start {
                return;
            }
        }
        let Some(sess) = self.machine.session() else {
            return;
        };
        let monotonic_ms = mono_ms(self.clock.monotonic(), sess.mono_origin);
        let session_id = sess.id;
        self.emit_raw(session_id, body, occurred_at, monotonic_ms);
    }

    fn emit_raw(
        &mut self,
        session_id: Uuid,
        body: EventBody,
        occurred_at: DateTime<Utc>,
        monotonic_ms: u64,
    ) {
        let event_type = body.event_type();
        let ev = NewEvent {
            organization_id: self.cfg.identity.organization_id.clone(),
            device_id: self.cfg.identity.device_id.clone(),
            session_id,
            policy_version: self.effective.revision,
            body,
            occurred_at,
            monotonic_ms,
        };
        match lock(&self.outbox).append(ev) {
            Ok(env) => {
                self.queued += 1;
                log::debug!("queued {event_type} #{}", env.sequence);
            }
            Err(e) => log::error!("could not queue {event_type}: {e}"),
        }
    }

    /// The open session while it counts toward the limits (`Active` or suspended).
    fn running_session(&self) -> Option<Uuid> {
        matches!(
            self.machine.state(),
            SessionState::Active | SessionState::Suspended
        )
        .then(|| self.machine.session().map(|s| s.id))
        .flatten()
    }

    fn local_date(&self, t: DateTime<Utc>) -> NaiveDate {
        match self.cfg.time_zone {
            Some(tz) => t.with_timezone(&tz).date_naive(),
            None => t.with_timezone(&Local).date_naive(),
        }
    }

    fn reminder_window(&self, now: DateTime<Utc>) -> Option<ReminderWindow> {
        let schedule = self.reminders.schedule.as_ref();
        let mine = &self.reminders.settings.my_hours;
        match self.cfg.time_zone {
            Some(tz) => reminders::window_today(now, &tz, schedule, mine),
            None => reminders::window_today(now, &Local, schedule, mine),
        }
    }

    /// Stage 4 F4 / F3, every tick: schedules the fetches (limits every 5 min while
    /// `Active`; the schedule at startup, hourly and when the date changes), raises
    /// limit warnings while `Active`, and steps the reminders. All local: nothing here
    /// queues an event.
    fn nudges(&mut self, now: ClockReading) {
        let today = self.local_date(now.wall);
        let schedule_due = self.last_schedule_fetch.is_none_or(|(at, date)| {
            date != today || reminders::refresh_due(Some(at), now.mono, SCHEDULE_REFRESH)
        });
        if schedule_due && self.license_block.is_none() {
            self.last_schedule_fetch = Some((now.mono, today));
            self.data_requests.push(DataRequest::ScheduleToday);
        }
        if self.limits.expire(now.wall) {
            self.save_meta(META_LIMITS, &self.limits);
        }
        let state = self.machine.state();
        let session = self.machine.session().map(|s| (s.id, s.started_at));
        if state == SessionState::Active {
            if reminders::refresh_due(self.last_limits_fetch, now.mono, LIMITS_REFRESH) {
                self.last_limits_fetch = Some(now.mono);
                self.data_requests.push(DataRequest::WorkLimits {
                    exclude_session_id: session.map(|(id, _)| id),
                });
            }
            let progress = self.limits.progress(
                session.map(|(id, _)| id),
                self.activity.unemitted_seconds(),
                now.wall,
            );
            let warnings = self.limits.ledger.check(&progress);
            if !warnings.is_empty() {
                self.save_meta(META_LIMITS, &self.limits);
            }
            for w in warnings {
                log::info!("work limit: {}% of the {:?} limit", w.percent, w.scope);
                self.notices.push(Notice::LimitWarning {
                    id: w.id(),
                    scope: w.scope,
                    percent: w.percent,
                    limit_minutes: w.limit_minutes,
                    worked_seconds: w.worked_seconds,
                });
            }
        }

        let tracking = match (state, session) {
            (SessionState::Active | SessionState::Suspended, Some((session_id, started_at))) => {
                Tracking::Active {
                    session_id,
                    started_at,
                }
            }
            (SessionState::Paused(_), _) => Tracking::Paused,
            _ => Tracking::Idle,
        };
        let window = self.reminder_window(now.wall);
        let before = self.reminders.ledger.clone();
        let input = ReminderInput {
            now: now.wall,
            settings: &self.reminders.settings,
            window: window.as_ref(),
            tracking,
            ran_today: self.today().tracked_seconds > 0,
            can_start: self.license_block.is_none(),
            pending: self.reminder.as_ref().map(|r| r.kind),
        };
        match reminders::step(&mut self.reminders.ledger, &input) {
            ReminderStep::Nothing => {}
            ReminderStep::Clear => self.reminder = None,
            ReminderStep::Show {
                kind,
                hours_start,
                hours_end,
                source,
            } => {
                let prompt = ReminderPrompt {
                    id: Uuid::new_v4(),
                    kind,
                    hours_start,
                    hours_end,
                    source,
                };
                log::info!("reminder: {kind:?}");
                self.notices.push(Notice::Reminder {
                    id: prompt.id,
                    reminder: kind,
                });
                self.reminder = Some(prompt);
            }
        }
        if self.reminders.ledger != before {
            self.save_meta(META_REMINDERS, &self.reminders);
        }
    }

    fn load_meta<T: serde::de::DeserializeOwned + Default>(
        &self,
        key: &str,
    ) -> Result<T, AgentError> {
        Ok(lock(&self.outbox)
            .get_meta(key)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    fn save_meta<T: Serialize>(&self, key: &str, value: &T) {
        if let Ok(json) = serde_json::to_string(value) {
            if let Err(e) = lock(&self.outbox).set_meta(key, &json) {
                log::debug!("could not persist {key}: {e}");
            }
        }
    }

    fn persist_session(&mut self, now: ClockReading) {
        let Some(sess) = self.machine.session() else {
            return;
        };
        if !self.machine.is_open() {
            return;
        }
        let snap = SessionSnapshot {
            session_id: sess.id,
            project_id: sess.project_id.clone(),
            task_id: sess.task_id.clone(),
            started_at: sess.started_at,
            paused: match self.machine.state() {
                SessionState::Paused(r) => Some(r),
                _ => None,
            },
            last_alive: now.wall,
            last_monotonic_ms: mono_ms(now.mono, sess.mono_origin),
            tracked_ms: u64::try_from(self.session_tracked.as_millis()).unwrap_or(u64::MAX),
        };
        if let Ok(json) = serde_json::to_string(&snap) {
            if let Err(e) = lock(&self.outbox).set_meta(META_SESSION, &json) {
                log::warn!("could not persist session snapshot: {e}");
            }
        }
    }

    fn write_status(&mut self) {
        if let Ok(json) = serde_json::to_string(&self.status()) {
            let _ = lock(&self.outbox).set_meta(META_AGENT_STATUS, &json);
        }
    }

    fn recover(&mut self) -> Result<(), AgentError> {
        let raw = lock(&self.outbox).get_meta(META_SESSION)?;
        let Some(snap) = raw.and_then(|r| serde_json::from_str::<SessionSnapshot>(&r).ok()) else {
            return Ok(());
        };
        let now = ClockReading::now(self.clock.as_ref());
        let down = (now.wall - snap.last_alive)
            .to_std()
            .unwrap_or(Duration::ZERO);
        let resume = matches!(self.cfg.recovery, Recovery::ResumeWithin(max) if down <= max)
            && now.wall >= snap.last_alive;
        self.effective = self.policy.effective(snap.project_id.as_deref());
        self.apply_effective();
        if !resume {
            log::info!("closing a session left open by a previous run");
            self.emit_raw(
                snap.session_id,
                EventBody::SessionStopped(SessionStopped {
                    reason: StopReason::Shutdown,
                }),
                snap.last_alive,
                snap.last_monotonic_ms,
            );
            lock(&self.outbox).delete_meta(META_SESSION)?;
            self.notices.push(Notice::Recovered {
                session_id: snap.session_id,
                resumed: false,
            });
            return Ok(());
        }
        log::info!("resuming a session left open by a previous run");
        let elapsed_ms = snap.last_monotonic_ms + u64::try_from(down.as_millis()).unwrap_or(0);
        let info = SessionInfo {
            id: snap.session_id,
            project_id: snap.project_id.clone(),
            task_id: snap.task_id.clone(),
            started_at: snap.started_at,
            mono_origin: now.mono.saturating_sub(Duration::from_millis(elapsed_ms)),
        };
        let state = snap
            .paused
            .map_or(SessionState::Active, SessionState::Paused);
        self.machine = SessionMachine::restore(info, state);
        self.session_tracked = Duration::from_millis(snap.tracked_ms);
        self.limits
            .session_started(snap.session_id, snap.started_at);
        if down > self.cfg.tick * 2 && state == SessionState::Active {
            self.emit(
                EventBody::DataGap(DataGap {
                    gap_start: snap.last_alive,
                    gap_end: now.wall,
                    reason: GapReason::OfflineAgentStopped,
                }),
                now.wall,
            );
        }
        if state == SessionState::Active {
            self.enter_active(now);
        }
        self.policy_requests.push(snap.project_id);
        self.persist_session(now);
        self.notices.push(Notice::Recovered {
            session_id: snap.session_id,
            resumed: true,
        });
        Ok(())
    }
}

// =====================================================================================
// Runtime: tick loop + network worker
// =====================================================================================

/// Commands for a running agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Start a session.
    Start {
        /// Project.
        project_id: Option<String>,
        /// Task.
        task_id: Option<String>,
    },
    /// Pause.
    Pause,
    /// Resume.
    Resume,
    /// Stop the session (keep running).
    Stop(StopReason),
    /// Stop the session, flush the outbox (bounded), and exit.
    Shutdown(StopReason),
    /// Select the project the session-start notice is for: fetches its policy now and
    /// publishes [`LiveStatus::preview`] for it from then on. Collects nothing.
    Preview {
        /// Project (`None` = no project).
        project_id: Option<String>,
    },
    /// The person's answer to [`Notice::IdleReturn`]: queues `idle.decision.v1` and
    /// clears [`LiveStatus::idle_prompt`]. Unknown or stale ids are ignored. Only the
    /// person answers: nothing else in the agent sends this.
    ResolveIdle {
        /// [`IdlePrompt::id`].
        id: Uuid,
        /// Keep, discard or reassign.
        decision: IdleDecision,
        /// Target project (required for `reassign`, ignored otherwise).
        project_id: Option<String>,
        /// Target task (`reassign` only, optional).
        task_id: Option<String>,
    },
    /// The person's answer to [`Notice::Reminder`]. Unknown or stale ids are ignored.
    ResolveReminder {
        /// [`ReminderPrompt::id`].
        id: Uuid,
        /// Their choice.
        choice: ReminderChoice,
    },
    /// The employee changed their reminder settings.
    SetReminderSettings(ReminderSettings),
}

/// Messages from the network worker.
#[derive(Debug, Clone)]
pub enum NetEvent {
    /// A policy document was fetched.
    Policy {
        /// Project it was fetched for.
        project_id: Option<String>,
        /// The document.
        signed: SignedPolicy,
    },
    /// Sessions rejected as overlapping.
    SessionsRejected(Vec<Uuid>),
    /// Connectivity changed.
    Online(bool),
    /// `401 device_revoked`.
    Revoked,
    /// `403 subscription_inactive` / `seat_unavailable` from any endpoint.
    LicenseBlocked(LicenseBlock),
    /// A heartbeat succeeded while blocked.
    LicenseRestored,
    /// Licence info from a successful heartbeat.
    License(Option<LicenseInfo>),
    /// The person's language from a successful heartbeat.
    Locale(Option<String>),
    /// Work limits were fetched (`None`: the plan has none).
    WorkLimits {
        /// The session they leave out.
        excluded: Option<Uuid>,
        /// The figures.
        limits: Option<WorkLimits>,
    },
    /// Today's schedule was fetched (`None`: the server has no schedules).
    Schedule(Option<ScheduleToday>),
}

/// Everything the tick loop can receive.
#[derive(Debug, Clone)]
pub enum Input {
    /// A command.
    Command(Command),
    /// A network event.
    Net(NetEvent),
}

/// Cloneable handle for controlling a [`Runtime`] from other threads.
#[derive(Debug, Clone)]
pub struct AgentHandle(Sender<Input>);

impl AgentHandle {
    /// Sends a command; returns `false` if the runtime has exited.
    pub fn send(&self, c: Command) -> bool {
        self.0.send(Input::Command(c)).is_ok()
    }
}

enum NetJob {
    Screenshot(ScreenshotJob),
    FetchPolicy(Option<String>),
    FetchWorkLimits(Option<Uuid>),
    FetchSchedule,
    Shutdown { deadline: Duration },
}

struct ChannelSink(Sender<NetJob>);

impl ScreenshotSink for ChannelSink {
    fn dispatch(&mut self, job: ScreenshotJob) {
        let _ = self.0.send(NetJob::Screenshot(job));
    }
}

#[derive(Debug, Clone, Default)]
struct Health {
    permissions: Permissions,
    applied_revision: i64,
    project_id: Option<String>,
}

/// Platform and infrastructure for a [`Runtime`].
pub struct RuntimeDeps {
    /// Clock.
    pub clock: Arc<dyn Clock>,
    /// Input counter.
    pub input: Box<dyn InputCounter>,
    /// Foreground app source.
    pub foreground: Box<dyn ForegroundApp>,
    /// Screen capturer (used on the network thread, after authorisation).
    pub capturer: Arc<dyn ScreenCapturer>,
    /// HTTP transport.
    pub transport: Arc<dyn HttpTransport>,
    /// Credential store (wiped on revocation).
    pub credentials: Arc<dyn CredentialStore>,
    /// Shared outbox.
    pub outbox: SharedOutbox,
    /// The device credential.
    pub device_credential: String,
    /// Seed for the agent's randomness (`None` = entropy).
    pub seed: Option<u64>,
}

/// Options for [`Runtime::run`].
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// Start a session immediately with this project/task (unless one was recovered).
    pub auto_start: Option<(Option<String>, Option<String>)>,
    /// Shut down after this long (CI / simulation).
    pub max_duration: Option<Duration>,
    /// How long the final sync may take on shutdown.
    pub final_sync_timeout: Duration,
    /// Interval between sync attempts.
    pub sync_interval: Duration,
    /// Interval between heartbeats.
    pub heartbeat_interval: Duration,
    /// Interval between policy refreshes.
    pub policy_interval: Duration,
    /// While refused for licensing reasons, heartbeats are retried at most this often
    /// (and nothing else is sent).
    pub license_retry_interval: Duration,
}

impl RunOptions {
    /// Production intervals: sync 5 s, heartbeat 60 s, policy 5 min, final sync 10 s.
    pub fn new() -> Self {
        Self {
            auto_start: None,
            max_duration: None,
            final_sync_timeout: Duration::from_secs(10),
            sync_interval: Duration::from_secs(5),
            heartbeat_interval: Duration::from_secs(60),
            policy_interval: Duration::from_secs(300),
            license_retry_interval: Duration::from_secs(15 * 60),
        }
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSummary {
    /// The device was revoked during the run.
    pub revoked: bool,
    /// Events still in the outbox at exit.
    pub outbox_depth: u64,
    /// Licence refusal in force at exit.
    pub license_block: Option<LicenseBlock>,
}

/// The tick loop and network worker.
pub struct Runtime {
    agent: Agent,
    rx: Receiver<Input>,
    tx: Sender<Input>,
    jobs_tx: Sender<NetJob>,
    jobs_rx: Option<Receiver<NetJob>>,
    clock: Arc<dyn Clock>,
    capturer: Arc<dyn ScreenCapturer>,
    transport: Arc<dyn HttpTransport>,
    credentials: Arc<dyn CredentialStore>,
    outbox: SharedOutbox,
    credential: String,
    server_url: String,
    tick: Duration,
    health: Arc<Mutex<Health>>,
    auto_start: Option<(Option<String>, Option<String>)>,
    observer: Option<Box<dyn RuntimeObserver>>,
    preview: Option<Option<String>>,
    sync_status: Arc<Mutex<SyncStatus>>,
    depth: Option<(Duration, u64)>,
}

impl Runtime {
    /// Builds the runtime and a handle for sending it commands.
    pub fn new(cfg: AgentConfig, deps: RuntimeDeps) -> Result<(Self, AgentHandle), AgentError> {
        let (tx, rx) = mpsc::channel();
        let (jobs_tx, jobs_rx) = mpsc::channel();
        let rng = deps
            .seed
            .map(StdRng::seed_from_u64)
            .unwrap_or_else(StdRng::from_entropy);
        let server_url = cfg.identity.server_url.clone();
        let tick = cfg.tick;
        let agent = Agent::new(
            cfg,
            AgentDeps {
                clock: deps.clock.clone(),
                input: deps.input,
                foreground: deps.foreground,
                outbox: deps.outbox.clone(),
                screenshots: Box::new(ChannelSink(jobs_tx.clone())),
                rng,
            },
        )?;
        let handle = AgentHandle(tx.clone());
        Ok((
            Self {
                agent,
                rx,
                tx,
                jobs_tx,
                jobs_rx: Some(jobs_rx),
                clock: deps.clock,
                capturer: deps.capturer,
                transport: deps.transport,
                credentials: deps.credentials,
                outbox: deps.outbox,
                credential: deps.device_credential,
                server_url,
                tick,
                health: Arc::new(Mutex::new(Health::default())),
                auto_start: None,
                observer: None,
                preview: None,
                sync_status: Arc::new(Mutex::new(SyncStatus::default())),
                depth: None,
            },
            handle,
        ))
    }

    /// Access to the agent (before `run`).
    pub fn agent_mut(&mut self) -> &mut Agent {
        &mut self.agent
    }

    /// Publishes [`LiveStatus`] snapshots and [`Notice`]s to `observer` (the tray app).
    pub fn with_observer(mut self, observer: Box<dyn RuntimeObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// Builds the current [`LiveStatus`].
    pub fn live_status(&mut self) -> LiveStatus {
        let now = self.clock.monotonic();
        let depth = match self.depth {
            Some((at, d)) if now.saturating_sub(at) < Duration::from_secs(5) => d,
            _ => {
                let d = lock(&self.outbox).depth().unwrap_or(0);
                self.depth = Some((now, d));
                d
            }
        };
        let preview = self
            .preview
            .clone()
            .map(|p| self.agent.policy_preview(p.as_deref()));
        LiveStatus {
            agent: self.agent.status(),
            session: self.agent.live_session(),
            settings: self.agent.effective_policy().settings.clone(),
            preview,
            permissions: self.agent.permissions(Some(self.capturer.as_ref())),
            today: self.agent.today(),
            sync: self
                .sync_status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            outbox_depth: depth,
            revoked: self.agent.is_revoked(),
            idle_prompt: self.agent.idle_prompt().cloned(),
            limits: self.agent.limit_summary(),
            reminder: self.agent.reminder().cloned(),
            reminders: self.agent.reminder_status(),
        }
    }

    fn publish(&mut self) {
        if self.observer.is_none() {
            return;
        }
        let status = self.live_status();
        if let Some(o) = self.observer.as_mut() {
            o.status(&status);
        }
    }

    fn update_health(&mut self) {
        let perms = self.agent.permissions(Some(self.capturer.as_ref()));
        let rev = self.agent.applied_policy_revision();
        let project = self.agent.current_project();
        let mut h = self.health.lock().unwrap_or_else(|e| e.into_inner());
        h.permissions = perms;
        h.applied_revision = rev;
        h.project_id = project;
    }

    fn forward_agent_outputs(&mut self) {
        for p in self.agent.take_policy_requests() {
            let _ = self.jobs_tx.send(NetJob::FetchPolicy(p));
        }
        for r in self.agent.take_data_requests() {
            let _ = self.jobs_tx.send(match r {
                DataRequest::WorkLimits { exclude_session_id } => {
                    NetJob::FetchWorkLimits(exclude_session_id)
                }
                DataRequest::ScheduleToday => NetJob::FetchSchedule,
            });
        }
        for n in self.agent.take_notices() {
            if let Some(o) = self.observer.as_mut() {
                o.notice(&n);
            }
            match n {
                Notice::SessionOverlap { .. } => log::warn!(
                    "NOTICE: your session was stopped because another work session is already active"
                ),
                Notice::Revoked => log::warn!(
                    "NOTICE: this device was revoked by your organization; tracking has stopped"
                ),
                Notice::OutsideWorkHours => {
                    log::info!("NOTICE: outside policy work hours; capture is paused")
                }
                Notice::LicenseUnavailable { block } => log::warn!("NOTICE: {}", block.message()),
                Notice::LicenseRestored => {
                    log::info!("NOTICE: tracking is available again")
                }
                Notice::Recovered { resumed, .. } => log::info!(
                    "NOTICE: a session from a previous run was {}",
                    if resumed { "resumed" } else { "closed" }
                ),
                Notice::IdleReturn { seconds, .. } => log::info!(
                    "NOTICE: welcome back after {} min idle; unless answered in the app, the time is kept",
                    (seconds + 30) / 60
                ),
                Notice::LimitWarning {
                    scope,
                    percent,
                    limit_minutes,
                    ..
                } => log::info!(
                    "NOTICE: {percent}% of your {} {} min work limit; tracking continues",
                    match scope {
                        LimitScope::Daily => "daily",
                        LimitScope::Weekly => "weekly",
                    },
                    limit_minutes
                ),
                Notice::Reminder { reminder, .. } => log::info!(
                    "NOTICE: {}",
                    match reminder {
                        ReminderKind::Start => "your hours have started; start tracking when ready",
                        ReminderKind::Stop => "your hours have ended and this session is still tracking",
                        ReminderKind::StillTracking => "still tracking past your hours",
                    }
                ),
            }
        }
    }

    /// Runs until shutdown or revocation.
    pub fn run(mut self, opts: RunOptions) -> Result<RunSummary, AgentError> {
        let worker = self.spawn_worker(&opts);
        self.auto_start = opts.auto_start.clone();
        self.maybe_auto_start();
        self.update_health();
        self.forward_agent_outputs();
        self.publish();

        let started = self.clock.monotonic();
        let mut next_tick = started + self.tick;
        let mut revoked = false;
        loop {
            let now = self.clock.monotonic();
            if opts
                .max_duration
                .is_some_and(|d| now.saturating_sub(started) >= d)
            {
                log::info!("run duration reached; shutting down");
                self.shutdown_session(StopReason::User);
                break;
            }
            let wait = next_tick.saturating_sub(now);
            match self.rx.recv_timeout(wait) {
                Ok(Input::Command(Command::Shutdown(reason))) => {
                    self.shutdown_session(reason);
                    break;
                }
                Ok(Input::Command(c)) => self.handle_command(c),
                Ok(Input::Net(NetEvent::Revoked)) => {
                    self.agent.on_revoked();
                    self.wipe_credentials();
                    revoked = true;
                }
                Ok(Input::Net(e)) => self.handle_net(e),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if revoked {
                self.forward_agent_outputs();
                self.publish();
                break;
            }
            let now = self.clock.monotonic();
            if now >= next_tick {
                self.agent.tick();
                next_tick += self.tick;
                if next_tick <= now {
                    next_tick = now + self.tick;
                }
                self.update_health();
                self.publish();
            }
            self.forward_agent_outputs();
        }

        let deadline = self.clock.monotonic() + opts.final_sync_timeout;
        let _ = self.jobs_tx.send(NetJob::Shutdown { deadline });
        if let Some(w) = worker {
            let _ = w.join();
        }
        // Drain a late revocation from the final sync.
        while let Ok(input) = self.rx.try_recv() {
            if let Input::Net(NetEvent::Revoked) = input {
                self.agent.on_revoked();
                self.wipe_credentials();
                revoked = true;
            }
        }
        self.depth = None;
        self.forward_agent_outputs();
        self.publish();
        let outbox_depth = lock(&self.outbox).depth().unwrap_or(0);
        Ok(RunSummary {
            revoked,
            outbox_depth,
            license_block: self.agent.license_block(),
        })
    }

    /// Headless mode: (re)start the configured session when none is open.
    fn maybe_auto_start(&mut self) {
        let Some((project, task)) = self.auto_start.clone() else {
            return;
        };
        if self.agent.machine.is_open() || self.agent.is_revoked() {
            return;
        }
        match self.agent.start(project, task) {
            Ok(_) => {}
            Err(AgentError::LicenseUnavailable(b)) => {
                log::warn!("not starting a session: {}", b.message())
            }
            Err(e) => log::error!("could not start session: {e}"),
        }
    }

    fn shutdown_session(&mut self, reason: StopReason) {
        if self.agent.machine.is_open() {
            if let Err(e) = self.agent.stop(reason) {
                log::error!("could not stop session: {e}");
            }
        }
    }

    fn wipe_credentials(&self) {
        for name in [secret_names::DEVICE_CREDENTIAL, secret_names::OUTBOX_KEY] {
            if let Err(e) = self.credentials.delete(name) {
                log::error!("could not delete {name}: {e}");
            }
        }
    }

    fn handle_command(&mut self, c: Command) {
        let r = match c {
            Command::Start {
                project_id,
                task_id,
            } => self.agent.start(project_id, task_id).map(|_| ()),
            Command::Pause => self.agent.pause(),
            Command::Resume => self.agent.resume(),
            Command::Stop(reason) => self.agent.stop(reason),
            Command::Shutdown(_) => Ok(()),
            Command::Preview { project_id } => {
                self.agent.request_policy(project_id.clone());
                self.preview = Some(project_id);
                Ok(())
            }
            Command::ResolveIdle {
                id,
                decision,
                project_id,
                task_id,
            } => self
                .agent
                .resolve_idle(id, decision, project_id, task_id)
                .map(|_| ()),
            Command::ResolveReminder { id, choice } => {
                self.agent.resolve_reminder(id, choice).map(|_| ())
            }
            Command::SetReminderSettings(s) => self.agent.set_reminder_settings(s),
        };
        if let Err(e) = r {
            log::warn!("command refused: {e}");
        }
        self.update_health();
        self.publish();
    }

    fn handle_net(&mut self, e: NetEvent) {
        match e {
            NetEvent::Policy { project_id, signed } => {
                self.agent.on_policy(project_id.as_deref(), &signed)
            }
            NetEvent::SessionsRejected(ids) => self.agent.on_sessions_rejected(&ids),
            NetEvent::Online(on) => self.agent.set_online(on),
            NetEvent::LicenseBlocked(b) => self.agent.on_license_blocked(b),
            NetEvent::LicenseRestored => {
                self.agent.on_license_restored();
                self.maybe_auto_start();
            }
            NetEvent::License(info) => self.agent.on_license_info(info),
            NetEvent::Locale(locale) => self.agent.on_locale(locale),
            NetEvent::WorkLimits { excluded, limits } => {
                self.agent.on_work_limits(limits, excluded)
            }
            NetEvent::Schedule(s) => self.agent.on_schedule(s),
            NetEvent::Revoked => {}
        }
        self.update_health();
        self.publish();
    }

    fn spawn_worker(&mut self, opts: &RunOptions) -> Option<JoinHandle<()>> {
        let jobs = self.jobs_rx.take()?;
        let start = self.clock.monotonic();
        let worker = NetWorker {
            blocked: self.agent.license_block(),
            next_sync: start,
            next_heartbeat: start,
            next_policy: start + opts.policy_interval,
            api: ApiClient::new(&self.server_url, self.transport.clone())
                .with_credential(self.credential.clone()),
            outbox: self.outbox.clone(),
            clock: self.clock.clone(),
            capturer: self.capturer.clone(),
            events: self.tx.clone(),
            health: self.health.clone(),
            syncer: Syncer::default(),
            opts: opts.clone(),
            status: SyncStatus::default(),
            shared_status: self.sync_status.clone(),
            online: true,
        };
        std::thread::Builder::new()
            .name("rd-agent-net".into())
            .spawn(move || worker.run(jobs))
            .map_err(|e| log::error!("could not start network thread: {e}"))
            .ok()
    }
}

struct NetWorker {
    api: ApiClient,
    outbox: SharedOutbox,
    clock: Arc<dyn Clock>,
    capturer: Arc<dyn ScreenCapturer>,
    events: Sender<Input>,
    health: Arc<Mutex<Health>>,
    syncer: Syncer,
    opts: RunOptions,
    status: SyncStatus,
    shared_status: Arc<Mutex<SyncStatus>>,
    online: bool,
    blocked: Option<LicenseBlock>,
    next_sync: Duration,
    next_heartbeat: Duration,
    next_policy: Duration,
}

enum SyncResult {
    Ok,
    Revoked,
    Failed,
}

impl NetWorker {
    fn send(&self, e: NetEvent) {
        let _ = self.events.send(Input::Net(e));
    }

    fn set_online(&mut self, online: bool) {
        if online != self.online {
            self.online = online;
            log::info!("{}", if online { "back online" } else { "offline" });
            self.send(NetEvent::Online(online));
        }
    }

    fn note_api_error(&mut self, e: &ApiError) {
        match e {
            ApiError::Transport(_) => self.set_online(false),
            ApiError::LicenseUnavailable(b) => self.block(*b),
            _ => {}
        }
    }

    /// Enters (or stays in) the licence-refused mode: nothing but a heartbeat every
    /// `license_retry_interval`.
    fn block(&mut self, b: LicenseBlock) {
        if self.blocked != Some(b) {
            self.send(NetEvent::LicenseBlocked(b));
        }
        self.blocked = Some(b);
        self.status.last_error = Some(b.code().to_owned());
        self.write_status();
        self.next_heartbeat = self.clock.monotonic() + self.opts.license_retry_interval;
    }

    fn unblock(&mut self) {
        if self.blocked.take().is_some() {
            self.send(NetEvent::LicenseRestored);
            self.status.last_error = None;
            let now = self.clock.monotonic();
            self.next_sync = now;
            self.next_policy = now;
        }
    }

    fn run(mut self, jobs: Receiver<NetJob>) {
        loop {
            match jobs.recv_timeout(Duration::from_millis(200)) {
                Ok(NetJob::Screenshot(_)) if self.blocked.is_some() => {
                    log::info!("screenshot skipped: tracking unavailable")
                }
                Ok(NetJob::Screenshot(job)) => self.screenshot(&job),
                Ok(NetJob::FetchPolicy(_)) if self.blocked.is_some() => {}
                Ok(NetJob::FetchPolicy(p)) => {
                    if self.fetch_policy(p) {
                        return;
                    }
                }
                Ok(NetJob::FetchWorkLimits(_) | NetJob::FetchSchedule)
                    if self.blocked.is_some() => {}
                Ok(NetJob::FetchWorkLimits(excluded)) => {
                    if self.fetch_work_limits(excluded) {
                        return;
                    }
                }
                Ok(NetJob::FetchSchedule) => {
                    if self.fetch_schedule() {
                        return;
                    }
                }
                Ok(NetJob::Shutdown { deadline }) => {
                    if self.blocked.is_none() {
                        self.final_sync(deadline);
                    }
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let now = self.clock.monotonic();
            if now >= self.next_heartbeat {
                self.next_heartbeat = now
                    + if self.blocked.is_some() {
                        self.opts.license_retry_interval
                    } else {
                        self.opts.heartbeat_interval
                    };
                if self.heartbeat() {
                    return;
                }
            }
            if self.blocked.is_some() {
                continue;
            }
            if now >= self.next_sync {
                self.next_sync = now + self.opts.sync_interval;
                if let SyncResult::Revoked = self.sync() {
                    return;
                }
            }
            if self.blocked.is_none() && now >= self.next_policy {
                self.next_policy = now + self.opts.policy_interval;
                let project = self.health().project_id;
                if self.fetch_policy(None) {
                    return;
                }
                if project.is_some() && self.blocked.is_none() && self.fetch_policy(project) {
                    return;
                }
            }
        }
    }

    fn health(&self) -> Health {
        self.health
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn write_status(&self) {
        *self.shared_status.lock().unwrap_or_else(|e| e.into_inner()) = self.status.clone();
        if let Ok(json) = serde_json::to_string(&self.status) {
            let _ = lock(&self.outbox).set_meta(META_SYNC_STATUS, &json);
        }
    }

    fn sync(&mut self) -> SyncResult {
        if lock(&self.outbox).depth().unwrap_or(0) == 0 {
            return SyncResult::Ok;
        }
        self.status.last_attempt_at = Some(self.clock.wall());
        let r = self
            .syncer
            .sync(&self.outbox, &self.api, self.clock.as_ref());
        let out = match r {
            Ok(report) => {
                self.set_online(true);
                self.status.last_success_at = Some(self.clock.wall());
                self.status.last_error = None;
                self.status.accepted_total += report.accepted as u64;
                if !report.overlapping_sessions.is_empty() {
                    self.send(NetEvent::SessionsRejected(report.overlapping_sessions));
                }
                SyncResult::Ok
            }
            Err(SyncError::Revoked) => {
                self.send(NetEvent::Revoked);
                return SyncResult::Revoked;
            }
            Err(SyncError::BackingOff(_)) => return SyncResult::Failed,
            Err(SyncError::LicenseUnavailable { block, partial }) => {
                self.status.accepted_total += partial.accepted as u64;
                self.block(block);
                return SyncResult::Failed;
            }
            Err(SyncError::Failed { error, partial }) => {
                self.note_api_error(&error);
                self.status.last_error = Some(error.to_string());
                self.status.accepted_total += partial.accepted as u64;
                if !partial.overlapping_sessions.is_empty() {
                    self.send(NetEvent::SessionsRejected(partial.overlapping_sessions));
                }
                SyncResult::Failed
            }
            Err(SyncError::Outbox(e)) => {
                self.status.last_error = Some(e.to_string());
                SyncResult::Failed
            }
        };
        self.write_status();
        out
    }

    fn final_sync(&mut self, deadline: Duration) {
        loop {
            match self.sync() {
                SyncResult::Revoked => return,
                SyncResult::Ok if lock(&self.outbox).depth().unwrap_or(0) == 0 => return,
                _ if self.blocked.is_some() => return,
                _ => {}
            }
            let now = self.clock.monotonic();
            if now >= deadline {
                log::info!(
                    "final sync incomplete; {} event(s) stay queued for next run",
                    lock(&self.outbox).depth().unwrap_or(0)
                );
                return;
            }
            let wait = self
                .syncer
                .backoff()
                .remaining(now)
                .max(Duration::from_millis(100));
            std::thread::sleep(wait.min(deadline.saturating_sub(now)));
        }
    }

    /// Returns `true` if the device turned out to be revoked.
    fn heartbeat(&mut self) -> bool {
        let h = self.health();
        let req = HeartbeatRequest {
            agent_version: crate::AGENT_VERSION.into(),
            client_time: crate::ts::to_millis(self.clock.wall()),
            permissions: h.permissions,
            outbox_depth: lock(&self.outbox).depth().unwrap_or(0),
            applied_policy_revision: h.applied_revision,
        };
        match self.api.heartbeat(&req) {
            Ok(resp) => {
                self.set_online(true);
                if resp.credential_status == "revoked" {
                    self.send(NetEvent::Revoked);
                    return true;
                }
                self.send(NetEvent::License(resp.license.clone()));
                self.send(NetEvent::Locale(resp.locale.clone()));
                self.unblock();
                if resp.policy_revision > h.applied_revision {
                    if self.fetch_policy(None) {
                        return true;
                    }
                    if h.project_id.is_some() && self.fetch_policy(h.project_id) {
                        return true;
                    }
                }
                false
            }
            Err(ApiError::DeviceRevoked) => {
                self.send(NetEvent::Revoked);
                true
            }
            Err(e) => {
                log::debug!("heartbeat failed: {e}");
                self.note_api_error(&e);
                false
            }
        }
    }

    /// Returns `true` if the device turned out to be revoked.
    fn fetch_policy(&mut self, project_id: Option<String>) -> bool {
        match self.api.policy(project_id.as_deref()) {
            Ok(signed) => {
                self.set_online(true);
                self.send(NetEvent::Policy { project_id, signed });
                false
            }
            Err(ApiError::DeviceRevoked) => {
                self.send(NetEvent::Revoked);
                true
            }
            Err(e) => {
                log::debug!("policy fetch failed: {e}");
                self.note_api_error(&e);
                false
            }
        }
    }

    /// Returns `true` if the device turned out to be revoked. Offline or failing: the
    /// agent keeps its last good copy. `404` (an older server): no limits.
    fn fetch_work_limits(&mut self, excluded: Option<Uuid>) -> bool {
        let limits = match self.api.work_limits(excluded) {
            Ok(l) => l,
            Err(ApiError::Http { status: 404, .. }) => None,
            Err(ApiError::DeviceRevoked) => {
                self.send(NetEvent::Revoked);
                return true;
            }
            Err(e) => {
                log::debug!("work limits fetch failed: {e}");
                self.note_api_error(&e);
                return false;
            }
        };
        self.set_online(true);
        self.send(NetEvent::WorkLimits { excluded, limits });
        false
    }

    /// Returns `true` if the device turned out to be revoked. Offline or failing: the
    /// cached copy stays. `404` (an older server): no schedules, "my hours" apply.
    fn fetch_schedule(&mut self) -> bool {
        let schedule = match self.api.schedule_today() {
            Ok(s) => Some(s),
            Err(ApiError::Http { status: 404, .. }) => None,
            Err(ApiError::DeviceRevoked) => {
                self.send(NetEvent::Revoked);
                return true;
            }
            Err(e) => {
                log::debug!("schedule fetch failed: {e}");
                self.note_api_error(&e);
                return false;
            }
        };
        self.set_online(true);
        self.send(NetEvent::Schedule(schedule));
        false
    }

    fn screenshot(&mut self, job: &ScreenshotJob) {
        match run_job(job, &self.api, self.capturer.as_ref(), self.clock.as_ref()) {
            ScreenshotOutcome::Completed { bytes, .. } => {
                log::info!("screenshot uploaded ({bytes} bytes)")
            }
            ScreenshotOutcome::Refused(code) => {
                log::info!("screenshot not authorised: {code}");
                if let Some(b) = LicenseBlock::from_code(&code) {
                    self.block(b);
                }
            }
            ScreenshotOutcome::Cancelled => log::info!("screenshot cancelled: session left Active"),
            ScreenshotOutcome::Failed(e) => log::warn!("screenshot failed: {e}"),
        }
    }
}

/// Status assembled from the outbox database, for `rd-agent status`.
#[derive(Debug, Clone, Serialize)]
pub struct StoredStatus {
    /// Last agent snapshot.
    pub agent: Option<AgentStatus>,
    /// Last sync snapshot.
    pub sync: Option<SyncStatus>,
    /// Queued events.
    pub outbox_depth: u64,
    /// Queued events by type.
    pub outbox_by_type: Vec<(String, u64)>,
    /// Last sequence number allocated.
    pub last_sequence: u64,
    /// Most recent rejections (reasons only).
    pub recent_rejections: Vec<crate::outbox::Rejection>,
}

/// Reads [`StoredStatus`] from an outbox.
pub fn stored_status(outbox: &SharedOutbox) -> Result<StoredStatus, AgentError> {
    let o = lock(outbox);
    Ok(StoredStatus {
        agent: o
            .get_meta(META_AGENT_STATUS)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        sync: o
            .get_meta(META_SYNC_STATUS)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        outbox_depth: o.depth()?,
        outbox_by_type: o.depth_by_type()?,
        last_sequence: o.last_sequence()?,
        recent_rejections: o.rejections(10)?,
    })
}

#[cfg(test)]
mod tests;
