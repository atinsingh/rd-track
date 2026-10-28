//! Owns the agent runtime (on its own tick thread) and the state the popover shows.

use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chrono::Utc;
use rd_agent::config::{self, Paths};
use rd_agent::native::logic::PromptLedger;
use rd_agent::native::{self, NativePlatform, Permission};
use rd_agent::{credentials, http, setup, simulated};
use rd_agent_core::api::{ApiClient, ApiError, DeviceProject};
use rd_agent_core::clock::SystemClock;
use rd_agent_core::describe::format_duration;
use rd_agent_core::events::StopReason;
use rd_agent_core::platform::CredentialStore;
use rd_agent_core::policy::PolicySettings;
use rd_agent_core::runtime::{
    AgentConfig, AgentHandle, Command, LiveStatus, Notice, PolicyPreview, RunOptions, Runtime,
    RuntimeDeps, RuntimeObserver,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::view::{self, Banner, BannerContext, SessionNotice, TrayState};

/// Where the app is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Not enrolled: show the enrollment screen.
    Enroll,
    /// Enrolled; the runtime is starting.
    Starting,
    /// The runtime is running.
    Running,
    /// Quitting (stopping the session, final sync).
    Stopping,
    /// The device was revoked; local data was wiped.
    Revoked,
    /// The runtime could not start.
    Error,
}

/// Everything the popover renders.
#[derive(Debug, Clone, Serialize)]
pub struct AppView {
    /// Lifecycle phase.
    pub phase: Phase,
    /// Error text for [`Phase::Error`].
    pub error: Option<String>,
    /// `idle`, `tracking`, `paused`.
    pub tray: TrayState,
    /// "TRACKING" / "PAUSED" / "NOT TRACKING".
    pub label: &'static str,
    /// Elapsed `H:MM:SS` of the open session.
    pub elapsed: Option<String>,
    /// The open session's project and task.
    pub session_project_id: Option<String>,
    /// Task of the open session.
    pub session_task_id: Option<String>,
    /// Camera badge text.
    pub camera: Option<String>,
    /// "6h 42m".
    pub today: String,
    /// "71%".
    pub activity: Option<String>,
    /// Sync line.
    pub sync: String,
    /// Banners.
    pub banners: Vec<Banner>,
    /// Whether a session can be started now.
    pub can_start: bool,
    /// The policy requires a project.
    pub require_project: bool,
    /// Projects for the pickers.
    pub projects: Vec<DeviceProject>,
    /// `Some(false)` when the server has no device project list (contract gap).
    pub projects_supported: Option<bool>,
    /// Server the device is enrolled with.
    pub server_url: Option<String>,
    /// Simulated platform (Linux development build).
    pub simulated: bool,
    /// App version.
    pub version: &'static str,
}

#[derive(Default)]
struct Inner {
    phase: Option<Phase>,
    error: Option<String>,
    live: Option<LiveStatus>,
    notices: Vec<(u64, Notice)>,
    next_notice: u64,
    dismissed: Vec<String>,
    acknowledged: Option<PolicySettings>,
    collection_changed: bool,
    projects: Vec<DeviceProject>,
    projects_supported: Option<bool>,
    server_url: Option<String>,
    tray: Option<(TrayState, String, Option<String>)>,
    update: Option<String>,
}

/// The agent controller (shared via Tauri state).
pub struct Controller {
    paths: Paths,
    creds: Arc<dyn CredentialStore>,
    simulated: bool,
    inner: Mutex<Inner>,
    handle: Mutex<Option<AgentHandle>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Credential store for the tray app: the OS keychain (Windows Credential Manager,
/// macOS Keychain). On Linux — a development target whose kernel keyring does not
/// survive a reboot — and with `RD_AGENT_CREDENTIAL_STORE=file`, `0600` files.
fn credential_store(paths: &Paths) -> Arc<dyn CredentialStore> {
    let file = cfg!(target_os = "linux")
        || std::env::var("RD_AGENT_CREDENTIAL_STORE").as_deref() == Ok("file");
    if file {
        Arc::new(credentials::FileCredentialStore::new(paths.secrets()))
    } else {
        Arc::new(credentials::KeychainCredentialStore::new(format!(
            "rd-agent:{}",
            paths.root.display()
        )))
    }
}

impl Controller {
    /// Creates the controller for the default data directory.
    pub fn new() -> Arc<Self> {
        let paths = Paths::new(config::data_dir(None));
        let simulated =
            !native::AVAILABLE || std::env::var("RD_AGENT_SIMULATE").as_deref() == Ok("1");
        let creds = credential_store(&paths);
        let server_url = config::load_identity(&paths.identity())
            .ok()
            .flatten()
            .map(|i| i.server_url);
        Arc::new(Self {
            paths,
            creds,
            simulated,
            inner: Mutex::new(Inner {
                server_url,
                ..Inner::default()
            }),
            handle: Mutex::new(None),
            thread: Mutex::new(None),
        })
    }

    fn ledger(&self) -> PromptLedger {
        PromptLedger::new(self.paths.root.clone())
    }

    /// Starts the runtime if enrolled, else shows enrollment. Returns `true` if
    /// enrollment is needed.
    pub fn boot(self: &Arc<Self>, app: &AppHandle) -> bool {
        let identity = config::load_identity(&self.paths.identity()).ok().flatten();
        if identity.as_ref().is_some_and(|i| i.revoked) {
            lock(&self.inner).phase = Some(Phase::Revoked);
            return true;
        }
        match setup::is_enrolled(&self.paths, self.creds.as_ref()) {
            Ok(true) => {
                self.spawn_runtime(app.clone());
                false
            }
            Ok(false) => {
                lock(&self.inner).phase = Some(Phase::Enroll);
                true
            }
            Err(e) => {
                let mut i = lock(&self.inner);
                i.phase = Some(Phase::Error);
                i.error = Some(e);
                true
            }
        }
    }

    fn collectors(&self) -> Result<NativePlatform, String> {
        if self.simulated {
            let seed = rand::random();
            return Ok(NativePlatform {
                input: Box::new(simulated::SimInput::new(seed)),
                foreground: Box::new(simulated::SimForeground::new(seed)),
                capturer: Arc::new(simulated::SimCapturer::new(seed)),
            });
        }
        native::platform().ok_or_else(|| "no native collectors on this OS".to_owned())
    }

    /// Spawns the tick thread running the agent runtime.
    pub fn spawn_runtime(self: &Arc<Self>, app: AppHandle) {
        lock(&self.inner).phase = Some(Phase::Starting);
        let me = self.clone();
        let spawned = std::thread::Builder::new()
            .name("rd-agent-tick".into())
            .spawn(move || {
                if let Err(e) = me.run_runtime(app.clone()) {
                    log::error!("agent runtime failed: {e}");
                    let mut i = lock(&me.inner);
                    i.phase = Some(Phase::Error);
                    i.error = Some(e);
                }
                *lock(&me.handle) = None;
                me.emit(&app);
            });
        match spawned {
            Ok(t) => *lock(&self.thread) = Some(t),
            Err(e) => {
                let mut i = lock(&self.inner);
                i.phase = Some(Phase::Error);
                i.error = Some(format!("cannot start the agent thread: {e}"));
            }
        }
    }

    /// Runs on the tick thread: the runtime is built here because native collectors
    /// may be thread-affine.
    fn run_runtime(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let (identity, credential) = setup::load_for_run(&self.paths, self.creds.as_ref())?;
        lock(&self.inner).server_url = Some(identity.server_url.clone());
        let NativePlatform {
            input,
            foreground,
            capturer,
        } = self.collectors()?;
        let outbox = setup::open_outbox(&self.paths, self.creds.as_ref())?;
        let (runtime, handle) = Runtime::new(
            AgentConfig::new(identity.clone()),
            RuntimeDeps {
                clock: Arc::new(SystemClock::new()),
                input,
                foreground,
                capturer,
                transport: Arc::new(http::UreqTransport::new()),
                credentials: self.creds.clone(),
                outbox,
                device_credential: credential,
                seed: None,
            },
        )
        .map_err(|e| e.to_string())?;
        *lock(&self.handle) = Some(handle);
        lock(&self.inner).phase = Some(Phase::Running);
        let runtime = runtime.with_observer(Box::new(Observer {
            app: app.clone(),
            ctl: self.clone(),
        }));
        let summary = runtime.run(RunOptions::new()).map_err(|e| e.to_string())?;
        if summary.revoked {
            setup::mark_revoked(&self.paths, &identity)?;
            lock(&self.inner).phase = Some(Phase::Revoked);
        } else if lock(&self.inner).phase == Some(Phase::Running) {
            lock(&self.inner).phase = Some(Phase::Stopping);
        }
        Ok(())
    }

    /// Sends a command to the runtime.
    pub fn send(&self, c: Command) -> Result<(), String> {
        match lock(&self.handle).as_ref() {
            Some(h) if h.send(c) => Ok(()),
            _ => Err("the agent is not running".into()),
        }
    }

    /// Stops the session (if any), lets the runtime flush (bounded) and waits for the
    /// tick thread. Used by Quit and by OS shutdown.
    pub fn shutdown(&self) {
        {
            let mut i = lock(&self.inner);
            if i.phase == Some(Phase::Running) {
                i.phase = Some(Phase::Stopping);
            }
        }
        let _ = self.send(Command::Shutdown(StopReason::User));
        if let Some(t) = lock(&self.thread).take() {
            // The runtime's final sync is bounded (10 s); give it a little more.
            let deadline = Instant::now() + Duration::from_secs(15);
            while !t.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            if t.is_finished() {
                let _ = t.join();
            }
        }
    }

    /// Enrolls this device and starts the runtime.
    pub fn enroll(
        self: &Arc<Self>,
        app: AppHandle,
        server: &str,
        code: &str,
        device_name: Option<String>,
    ) -> Result<(), String> {
        let force = lock(&self.inner).phase == Some(Phase::Revoked);
        let identity = setup::enroll(
            &self.paths,
            self.creds.as_ref(),
            server,
            code,
            device_name,
            force,
        )?;
        {
            let mut i = lock(&self.inner);
            i.server_url = Some(identity.server_url);
            i.notices.clear();
            i.dismissed.clear();
            i.error = None;
        }
        self.spawn_runtime(app);
        Ok(())
    }

    /// Back to the enrollment screen after revocation.
    pub fn reenroll(&self) {
        let mut i = lock(&self.inner);
        if matches!(i.phase, Some(Phase::Revoked) | Some(Phase::Error)) {
            i.phase = Some(Phase::Enroll);
        }
    }

    /// Fetches the project list (blocking; call off the UI thread).
    pub fn refresh_projects(&self) -> Result<(), String> {
        let (identity, credential) = setup::load_for_run(&self.paths, self.creds.as_ref())?;
        let api = ApiClient::new(&identity.server_url, Arc::new(http::UreqTransport::new()))
            .with_credential(credential);
        let r = api.projects();
        let mut i = lock(&self.inner);
        match r {
            Ok(p) => {
                i.projects = p;
                i.projects_supported = Some(true);
                Ok(())
            }
            Err(ApiError::Http { status: 404, .. }) => {
                i.projects_supported = Some(false);
                Ok(())
            }
            Err(e) => Err(format!("could not load projects: {e}")),
        }
    }

    /// Selects `project` for the session-start notice and waits (≤ 4 s) for its
    /// verified policy. Blocking.
    pub fn prepare(
        &self,
        project_id: Option<String>,
        task_id: Option<String>,
    ) -> Result<SessionNotice, String> {
        self.send(Command::Preview {
            project_id: project_id.clone(),
        })?;
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut last: Option<PolicyPreview> = None;
        loop {
            {
                let i = lock(&self.inner);
                let online = i.live.as_ref().is_none_or(|l| l.agent.online);
                if let Some(p) = i.live.as_ref().and_then(|l| l.preview.clone()) {
                    if p.project_id == project_id {
                        let done = p.source == "exact" || !online;
                        last = Some(p);
                        if done {
                            break;
                        }
                    }
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let preview = last.ok_or("the agent did not answer; try again")?;
        let i = lock(&self.inner);
        let name = view::project_name(&i.projects, project_id.as_deref());
        Ok(view::session_notice(&preview, task_id, name))
    }

    /// Starts a session after the employee confirmed the notice for `project_id`.
    pub fn start(&self, project_id: Option<String>, task_id: Option<String>) -> Result<(), String> {
        {
            let mut i = lock(&self.inner);
            let live = i.live.as_ref().ok_or("the agent is still starting")?;
            if let Some(m) = &live.agent.tracking_unavailable_message {
                return Err(m.clone());
            }
            if live.session.is_some() {
                return Err("a session is already running".into());
            }
            let preview = live
                .preview
                .as_ref()
                .filter(|p| p.project_id == project_id)
                .ok_or("review what this session collects first")?;
            if project_id.is_none() && preview.settings.session.require_project {
                return Err("Your organization requires a project for every session.".into());
            }
            i.acknowledged = Some(preview.settings.clone());
            i.collection_changed = false;
            i.dismissed.retain(|d| d != "collection-changed");
        }
        self.send(Command::Start {
            project_id,
            task_id,
        })?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if lock(&self.inner)
                .live
                .as_ref()
                .is_some_and(|l| l.session.is_some())
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("The session did not start. Check the banner above or try again.".into())
    }

    /// The notice for the running session's current settings (after a policy change);
    /// marks it as seen.
    pub fn review(&self) -> Result<SessionNotice, String> {
        let mut i = lock(&self.inner);
        let live = i.live.as_ref().ok_or("the agent is still starting")?;
        let session = live.session.as_ref().ok_or("no session is running")?;
        let preview = PolicyPreview {
            project_id: session.project_id.clone(),
            source: live.agent.policy_source.clone(),
            revision: live.agent.policy_revision,
            settings: live.settings.clone(),
        };
        let task = session.task_id.clone();
        let notice = view::session_notice(
            &preview,
            task,
            view::project_name(&i.projects, preview.project_id.as_deref()),
        );
        i.acknowledged = Some(preview.settings);
        i.collection_changed = false;
        Ok(notice)
    }

    /// Dismisses a banner.
    pub fn dismiss(&self, id: &str) {
        let mut i = lock(&self.inner);
        if !i.dismissed.iter().any(|d| d == id) {
            i.dismissed.push(id.to_owned());
        }
        if let Some(n) = id.strip_prefix('n').and_then(|n| n.parse::<u64>().ok()) {
            i.notices.retain(|(nid, _)| *nid != n);
        }
    }

    /// Shows the OS prompt for a permission, at most once per install.
    pub fn request_permission(&self, name: &str) -> Result<bool, String> {
        let p = Permission::from_name(name).ok_or("unknown permission")?;
        Ok(native::request_permission_once(p, &self.ledger()))
    }

    /// The System Settings URL for a permission (macOS), from a fixed allowlist.
    pub fn permission_settings_url(name: &str) -> Option<&'static str> {
        Permission::from_name(name).and_then(Permission::settings_url)
    }

    /// "My dashboard": `RD_TRACK_DASHBOARD_URL`, else `<server>/me`.
    pub fn dashboard_url(&self) -> Option<String> {
        if let Ok(u) = std::env::var("RD_TRACK_DASHBOARD_URL") {
            if u.starts_with("https://") || u.starts_with("http://") {
                return Some(u);
            }
        }
        let server = lock(&self.inner).server_url.clone()?;
        (server.starts_with("https://") || server.starts_with("http://"))
            .then(|| format!("{}/me", server.trim_end_matches('/')))
    }

    /// Records that an update is ready.
    pub fn set_update(&self, version: Option<String>) {
        lock(&self.inner).update = version;
    }

    /// Builds the popover view.
    pub fn view(&self) -> AppView {
        let i = lock(&self.inner);
        let live = i.live.as_ref();
        let prompted: Vec<&str> = ["screen_recording", "input_monitoring"]
            .into_iter()
            .filter(|n| self.ledger().was_prompted(n))
            .collect();
        let banners = view::banners(
            live,
            &BannerContext {
                notices: &i.notices,
                dismissed: &i.dismissed,
                prompted: &prompted,
                collection_changed: i.collection_changed,
                simulated: self.simulated,
                macos: cfg!(target_os = "macos"),
                update: i.update.as_deref(),
            },
        );
        let tray = TrayState::of(live);
        let session = live.and_then(|l| l.session.as_ref());
        AppView {
            phase: i.phase.unwrap_or(Phase::Starting),
            error: i.error.clone(),
            tray,
            label: match tray {
                TrayState::Tracking => "TRACKING",
                TrayState::Paused => "PAUSED",
                TrayState::Idle => "NOT TRACKING",
            },
            elapsed: session.map(|s| view::clock(s.tracked_seconds)),
            session_project_id: session.and_then(|s| s.project_id.clone()),
            session_task_id: session.and_then(|s| s.task_id.clone()),
            camera: live.and_then(|l| view::camera_badge(&l.settings, l.session.is_some())),
            today: format_duration(live.map_or(0, |l| l.today.tracked_seconds)),
            activity: live
                .and_then(|l| l.today.activity_percent())
                .map(|p| format!("{p}%")),
            sync: live
                .map(|l| view::sync_line(l, Utc::now()))
                .unwrap_or_else(|| "Starting…".into()),
            banners,
            can_start: live.is_some_and(|l| {
                l.session.is_none() && l.agent.tracking_unavailable.is_none() && !l.revoked
            }),
            require_project: live.is_some_and(|l| l.settings.session.require_project),
            projects: i.projects.clone(),
            projects_supported: i.projects_supported,
            server_url: i.server_url.clone(),
            simulated: self.simulated,
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    /// Pushes the view to the popover and refreshes the tray.
    pub fn emit(&self, app: &AppHandle) {
        let v = self.view();
        let project = {
            let i = lock(&self.inner);
            view::project_name(&i.projects, v.session_project_id.as_deref()).map(str::to_owned)
        };
        let (tooltip, title) = {
            let i = lock(&self.inner);
            view::tray_text(i.live.as_ref(), project.as_deref())
        };
        let changed = {
            let mut i = lock(&self.inner);
            let next = (v.tray, tooltip.clone(), title.clone());
            let changed = i.tray.as_ref() != Some(&next);
            i.tray = Some(next);
            changed
        };
        if changed {
            crate::tray::update(app, v.tray, &tooltip, title.as_deref());
        }
        let _ = app.emit_to("main", "view", &v);
    }
}

/// Receives runtime updates on the tick thread.
struct Observer {
    app: AppHandle,
    ctl: Arc<Controller>,
}

impl RuntimeObserver for Observer {
    fn status(&mut self, status: &LiveStatus) {
        {
            let mut i = lock(&self.ctl.inner);
            if status.session.is_some() {
                if let Some(ack) = &i.acknowledged {
                    if view::expands(ack, &status.settings) && !i.collection_changed {
                        i.collection_changed = true;
                        i.dismissed.retain(|d| d != "collection-changed");
                    }
                } else {
                    // A session recovered after a restart: what it runs under now is
                    // what the employee saw when starting it.
                    i.acknowledged = Some(status.settings.clone());
                }
            } else {
                i.acknowledged = None;
                i.collection_changed = false;
            }
            i.live = Some(status.clone());
            if status.revoked {
                i.phase = Some(Phase::Revoked);
            }
        }
        self.ctl.emit(&self.app);
    }

    fn notice(&mut self, notice: &Notice) {
        let mut i = lock(&self.ctl.inner);
        let id = i.next_notice;
        i.next_notice += 1;
        i.notices.push((id, notice.clone()));
        if i.notices.len() > 5 {
            i.notices.remove(0);
        }
    }
}
