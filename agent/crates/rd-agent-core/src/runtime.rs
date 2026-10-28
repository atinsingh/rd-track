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

use chrono::{DateTime, TimeDelta, Utc};
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::activity::ActivityAggregator;
use crate::api::{ApiClient, ApiError, HeartbeatRequest};
use crate::apps::AppTracker;
use crate::clock::{Clock, ClockReading, TickKind, TickObserver};
use crate::events::{DataGap, EventBody, GapReason, PauseReason, SessionStopped, StopReason};
use crate::identity::DeviceIdentity;
use crate::outbox::{lock, NewEvent, OutboxConfig, OutboxPolicyCache, SharedOutbox};
use crate::platform::{
    secret_names, CredentialStore, ForegroundApp, ForegroundAppInfo, HttpTransport,
    InputCounter, Permissions, ScreenCapturer,
};
use crate::policy::{EffectivePolicy, PolicySource, PolicyStore, SignedPolicy};
use crate::screenshot::{
    run_job, GateController, ScreenshotJob, ScreenshotOutcome, ScreenshotScheduler,
    ScreenshotSink, SlotDecision,
};
use crate::state::{SessionInfo, SessionMachine, SessionState, TransitionError};
use crate::sync::{SyncError, Syncer};

/// Outbox metadata key holding the open-session snapshot (crash recovery).
pub const META_SESSION: &str = "session_snapshot";
/// Outbox metadata key holding the latest [`AgentStatus`].
pub const META_AGENT_STATUS: &str = "agent_status";
/// Outbox metadata key holding the latest [`SyncStatus`].
pub const META_SYNC_STATUS: &str = "sync_status";

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
    /// Local storage error.
    #[error(transparent)]
    Outbox(#[from] crate::outbox::OutboxError),
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
}

impl AgentConfig {
    /// Production defaults: 1 s tick, resume a session after ≤ 10 minutes of downtime.
    pub fn new(identity: DeviceIdentity) -> Self {
        Self {
            identity,
            tick: Duration::from_secs(1),
            recovery: Recovery::ResumeWithin(Duration::from_secs(600)),
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
#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// A session left open by a previous run was resumed or closed.
    Recovered {
        /// The session.
        session_id: Uuid,
        /// `true` if resumed, `false` if stopped at the last time the agent was seen.
        resumed: bool,
    },
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
    ticks: u64,
    queued: usize,
    notices: Vec<Notice>,
    policy_requests: Vec<Option<String>>,
}

impl std::fmt::Debug for Agent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agent")
            .field("state", &self.machine.state())
            .field("policy_revision", &self.effective.revision)
            .finish()
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
            scheduler: ScreenshotScheduler::new(effective.settings.screenshot_interval(), tolerance),
            gates: GateController::new(),
            observer: TickObserver::new(cfg.tick),
            last_capture: None,
            last_foreground: None,
            online: true,
            revoked: false,
            ticks: 0,
            queued: 0,
            notices: Vec::new(),
            policy_requests: vec![None],
            effective,
            policy,
            cfg,
        };
        agent.input.set_capturing(false);
        agent.apply_effective();
        agent.recover()?;
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

    /// Takes user-facing notices produced since the last call.
    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    /// Takes the projects whose policy should be fetched now (`None` = base policy).
    pub fn take_policy_requests(&mut self) -> Vec<Option<String>> {
        std::mem::take(&mut self.policy_requests)
    }

    /// `true` once the device has been revoked.
    pub fn is_revoked(&self) -> bool {
        self.revoked
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
            policy_source: match self.effective.source {
                PolicySource::Exact => "exact",
                PolicySource::BaseFallback => "base_fallback",
                PolicySource::Defaults => "defaults",
            }
            .to_owned(),
            screenshots_enabled: self.effective.settings.screenshots.enabled,
            idle_threshold_seconds: self.effective.settings.idle.threshold_seconds,
            online: self.online,
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
        let now = ClockReading::now(self.clock.as_ref());
        self.resume_at(now)?;
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
        self.write_status();
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

    /// `401 device_revoked`: stop collecting at once (no event — the server already
    /// knows), and wipe the outbox. The caller wipes the credential.
    pub fn on_revoked(&mut self) {
        if self.revoked {
            return;
        }
        self.revoked = true;
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
                TickKind::Suspended { gap_start, gap_end } => self.on_suspend(gap_start, gap_end, now),
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
        let sample = self.input.sample();
        let buckets = self.activity.record(now.wall, elapsed, sample);
        self.emit_buckets(buckets, now.wall);

        let s = &self.effective.settings;
        let want_apps = s.apps.capture_app_name;
        let want_fg = want_apps || (s.screenshots.enabled && !s.screenshots.excluded_apps.is_empty());
        self.last_foreground = if want_fg { self.foreground.current() } else { None };
        if want_apps {
            let segs = self
                .apps
                .record(now.wall, elapsed, self.last_foreground.clone());
            self.emit_apps(segs, now.wall);
        }
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

    fn on_clock_change(&mut self, gap_start: DateTime<Utc>, gap_end: DateTime<Utc>, now: ClockReading) {
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
        self.scheduler.set_interval(interval, now.wall, &mut self.rng);
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

    fn emit_buckets(&mut self, buckets: Vec<crate::events::ActivityBucket>, now: DateTime<Utc>) {
        for b in buckets {
            let end = b.bucket_start + TimeDelta::minutes(1);
            self.emit(EventBody::ActivityBucket(b), end.min(now));
        }
    }

    fn emit_apps(&mut self, segs: Vec<crate::events::AppUsage>, now: DateTime<Utc>) {
        for s in segs {
            self.emit(EventBody::AppUsage(s), now);
        }
    }

    fn emit(&mut self, body: EventBody, occurred_at: DateTime<Utc>) {
        let Some(sess) = self.machine.session() else {
            return;
        };
        let monotonic_ms = mono_ms(self.clock.monotonic(), sess.mono_origin);
        let session_id = sess.id;
        self.emit_raw(session_id, body, occurred_at, monotonic_ms);
    }

    fn emit_raw(&mut self, session_id: Uuid, body: EventBody, occurred_at: DateTime<Utc>, monotonic_ms: u64) {
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
        let down = (now.wall - snap.last_alive).to_std().unwrap_or(Duration::ZERO);
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
        let state = snap.paused.map_or(SessionState::Active, SessionState::Paused);
        self.machine = SessionMachine::restore(info, state);
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
            },
            handle,
        ))
    }

    /// Access to the agent (before `run`).
    pub fn agent_mut(&mut self) -> &mut Agent {
        &mut self.agent
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
        for n in self.agent.take_notices() {
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
                Notice::Recovered { resumed, .. } => log::info!(
                    "NOTICE: a session from a previous run was {}",
                    if resumed { "resumed" } else { "closed" }
                ),
            }
        }
    }

    /// Runs until shutdown or revocation.
    pub fn run(mut self, opts: RunOptions) -> Result<RunSummary, AgentError> {
        let worker = self.spawn_worker(&opts);
        if let Some((project, task)) = opts.auto_start.clone() {
            if !self.agent.machine.is_open() {
                if let Err(e) = self.agent.start(project, task) {
                    log::error!("could not start session: {e}");
                }
            }
        }
        self.update_health();
        self.forward_agent_outputs();

        let started = self.clock.monotonic();
        let mut next_tick = started + self.tick;
        let mut revoked = false;
        loop {
            let now = self.clock.monotonic();
            if opts.max_duration.is_some_and(|d| now.saturating_sub(started) >= d) {
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
        let outbox_depth = lock(&self.outbox).depth().unwrap_or(0);
        Ok(RunSummary {
            revoked,
            outbox_depth,
        })
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
        };
        if let Err(e) = r {
            log::warn!("command refused: {e}");
        }
        self.update_health();
    }

    fn handle_net(&mut self, e: NetEvent) {
        match e {
            NetEvent::Policy {
                project_id,
                signed,
            } => self.agent.on_policy(project_id.as_deref(), &signed),
            NetEvent::SessionsRejected(ids) => self.agent.on_sessions_rejected(&ids),
            NetEvent::Online(on) => self.agent.set_online(on),
            NetEvent::Revoked => {}
        }
    }

    fn spawn_worker(&mut self, opts: &RunOptions) -> Option<JoinHandle<()>> {
        let jobs = self.jobs_rx.take()?;
        let worker = NetWorker {
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
    online: bool,
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
        if matches!(e, ApiError::Transport(_)) {
            self.set_online(false);
        }
    }

    fn run(mut self, jobs: Receiver<NetJob>) {
        let start = self.clock.monotonic();
        let mut next_sync = start;
        let mut next_heartbeat = start;
        let mut next_policy = start + self.opts.policy_interval;
        loop {
            match jobs.recv_timeout(Duration::from_millis(200)) {
                Ok(NetJob::Screenshot(job)) => self.screenshot(&job),
                Ok(NetJob::FetchPolicy(p)) => {
                    if self.fetch_policy(p) {
                        return;
                    }
                }
                Ok(NetJob::Shutdown { deadline }) => {
                    self.final_sync(deadline);
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let now = self.clock.monotonic();
            if now >= next_sync {
                next_sync = now + self.opts.sync_interval;
                if let SyncResult::Revoked = self.sync() {
                    return;
                }
            }
            if now >= next_heartbeat {
                next_heartbeat = now + self.opts.heartbeat_interval;
                if self.heartbeat() {
                    return;
                }
            }
            if now >= next_policy {
                next_policy = now + self.opts.policy_interval;
                let project = self.health().project_id;
                if self.fetch_policy(None) {
                    return;
                }
                if project.is_some() && self.fetch_policy(project) {
                    return;
                }
            }
        }
    }

    fn health(&self) -> Health {
        self.health.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn write_status(&self) {
        if let Ok(json) = serde_json::to_string(&self.status) {
            let _ = lock(&self.outbox).set_meta(META_SYNC_STATUS, &json);
        }
    }

    fn sync(&mut self) -> SyncResult {
        if lock(&self.outbox).depth().unwrap_or(0) == 0 {
            return SyncResult::Ok;
        }
        self.status.last_attempt_at = Some(self.clock.wall());
        let r = self.syncer.sync(&self.outbox, &self.api, self.clock.as_ref());
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
            let wait = self.syncer.backoff().remaining(now).max(Duration::from_millis(100));
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

    fn screenshot(&mut self, job: &ScreenshotJob) {
        match run_job(job, &self.api, self.capturer.as_ref(), self.clock.as_ref()) {
            ScreenshotOutcome::Completed { bytes, .. } => {
                log::info!("screenshot uploaded ({bytes} bytes)")
            }
            ScreenshotOutcome::Refused(code) => log::info!("screenshot not authorised: {code}"),
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
