//! Owns the agent runtime (on its own tick thread) and the state the popover shows.

use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chrono::{Local, Utc};
use rd_agent::config::{self, Paths};
use rd_agent::native::logic::PromptLedger;
use rd_agent::native::{self, NativePlatform, Permission};
use rd_agent::{credentials, http, setup, simulated};
use rd_agent_core::api::{ApiClient, ApiError, DeviceProject};
use rd_agent_core::clock::SystemClock;
use rd_agent_core::describe::format_duration;
use rd_agent_core::events::StopReason;
use rd_agent_core::i18n::Lang;
use rd_agent_core::platform::CredentialStore;
use rd_agent_core::policy::PolicySettings;
use rd_agent_core::runtime::{
    AgentConfig, AgentHandle, Command, LiveStatus, Notice, PolicyPreview, RunOptions, Runtime,
    RuntimeDeps, RuntimeObserver,
};
use serde::Serialize;

use crate::link::EnrollPrefill;
use tauri::{AppHandle, Emitter};

use crate::view::{
    self, Banner, BannerContext, IdleView, ReminderView, RemindersInput, RemindersView,
    SessionNotice, TrayState,
};

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
    /// The language every text in this view is written in.
    pub lang: Lang,
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
    /// "5h 12m of 8h today" when a daily work limit applies.
    pub limit_today: Option<String>,
    /// "31h 05m of 40h this week" when a weekly work limit applies.
    pub limit_week: Option<String>,
    /// Sync line.
    pub sync: String,
    /// Banners.
    pub banners: Vec<Banner>,
    /// The "Welcome back" panel while an idle-return prompt is unanswered.
    pub idle: Option<IdleView>,
    /// The reminder card (never while paused).
    pub reminder: Option<ReminderView>,
    /// The "Reminders" settings section.
    pub reminders: RemindersView,
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
    /// Filled in from an `rdtrack://enroll` link while not enrolled.
    pub enroll_prefill: Option<EnrollPrefill>,
    /// IT deployed this computer for an organization (G26): connect with a work email.
    pub deployment: Option<DeploymentView>,
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
    dashboard_url: Option<String>,
    tray: Option<(TrayState, String, Option<String>)>,
    update: Option<String>,
    enroll_prefill: Option<EnrollPrefill>,
    deployment: Option<config::Deployment>,
    /// The computer's own language (before the server says, or when the person has no choice).
    system_lang: Lang,
    /// The person's language from the server, remembered between starts.
    server_locale: Option<String>,
    /// The language the tray menu was last written in.
    tray_lang: Option<Lang>,
}

impl Inner {
    fn lang(&self) -> Lang {
        self.server_locale
            .as_deref()
            .map_or(self.system_lang, Lang::from_tag)
    }
}

/// Where the person's language from the server is remembered.
fn locale_file(paths: &Paths) -> std::path::PathBuf {
    paths.root.join("locale")
}

/// What the enrolment screen shows of the deployment file (never the key).
#[derive(Debug, Clone, Serialize)]
pub struct DeploymentView {
    /// The organization's Track address.
    pub server_url: String,
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
        let identity = config::load_identity(&paths.identity()).ok().flatten();
        let dashboard_url = identity.as_ref().and_then(|i| i.dashboard_url.clone());
        let server_url = identity.map(|i| i.server_url);
        let system_lang = sys_locale::get_locale().map_or(Lang::En, |t| Lang::from_tag(&t));
        let server_locale = std::fs::read_to_string(locale_file(&paths))
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        Arc::new(Self {
            paths,
            creds,
            simulated,
            inner: Mutex::new(Inner {
                server_url,
                dashboard_url,
                system_lang,
                server_locale,
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
                let mut i = lock(&self.inner);
                i.phase = Some(Phase::Enroll);
                i.deployment = config::load_deployment(&config::deployment_file());
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
        {
            let mut i = lock(&self.inner);
            i.server_url = Some(identity.server_url.clone());
            i.dashboard_url = identity.dashboard_url.clone();
        }
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
            i.enroll_prefill = None;
            i.dashboard_url = identity.dashboard_url;
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
            i.deployment = config::load_deployment(&config::deployment_file());
        }
    }

    /// On a computer IT deployed: asks the server to email the person a code (blocking).
    pub fn request_email_code(&self, email: &str) -> Result<(), String> {
        let deployment = lock(&self.inner)
            .deployment
            .clone()
            .ok_or("this computer wasn't set up by your IT team")?;
        setup::request_email_code(&deployment, email, self.lang())
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
        Ok(view::session_notice(&preview, task_id, name, i.lang()))
    }

    /// Starts a session after the employee confirmed the notice for `project_id`.
    pub fn start(&self, project_id: Option<String>, task_id: Option<String>) -> Result<(), String> {
        {
            let mut i = lock(&self.inner);
            let lang = i.lang();
            let live = i.live.as_ref().ok_or("the agent is still starting")?;
            if let Some(b) = live.agent.tracking_unavailable {
                return Err(b.message_in(lang).to_owned());
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
                return Err(lang.messages().err_project_required.into());
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
        Err(self.lang().messages().err_not_started.into())
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
            i.lang(),
        );
        i.acknowledged = Some(preview.settings);
        i.collection_changed = false;
        Ok(notice)
    }

    /// The person's answer to the idle-return prompt `id` (`keep`, `discard` or
    /// `reassign` with a project from the offered list). Queued by the runtime as
    /// `idle.decision.v1`; waits (≤ 2 s) until the prompt is cleared. Blocking.
    pub fn resolve_idle(
        &self,
        id: &str,
        decision: &str,
        project_id: Option<String>,
        task_id: Option<String>,
    ) -> Result<(), String> {
        let decision = view::parse_idle_decision(decision).ok_or("unknown choice")?;
        let id = uuid::Uuid::parse_str(id).map_err(|_| "unknown prompt")?;
        let (project_id, task_id) = {
            let i = lock(&self.inner);
            let prompt = i
                .live
                .as_ref()
                .and_then(|l| l.idle_prompt.as_ref())
                .filter(|p| p.id == id)
                .ok_or(i.lang().messages().err_answered)?;
            if decision == rd_agent_core::events::IdleDecision::Reassign {
                let v = view::idle_view(prompt, &i.projects, &Local, i.lang());
                view::check_idle_target(&v, project_id.as_deref(), task_id.as_deref(), i.lang())?;
                (project_id, task_id)
            } else {
                (None, None)
            }
        };
        self.send(Command::ResolveIdle {
            id,
            decision,
            project_id,
            task_id,
        })?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let pending = lock(&self.inner)
                .live
                .as_ref()
                .and_then(|l| l.idle_prompt.as_ref())
                .is_some_and(|p| p.id == id);
            if !pending {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(self.lang().messages().err_choice_not_saved.into())
    }

    /// The person's answer to the reminder `id` (`start`, `not_today`, `stop`, `keep`).
    /// Waits (≤ 2 s) until the runtime has cleared it. Blocking. For `start` the
    /// popover then runs its usual start flow (project, session-start notice).
    pub fn resolve_reminder(&self, id: &str, choice: &str) -> Result<(), String> {
        let choice = view::parse_reminder_choice(choice).ok_or("unknown choice")?;
        let id = uuid::Uuid::parse_str(id).map_err(|_| "unknown reminder")?;
        {
            let i = lock(&self.inner);
            let shown = i
                .live
                .as_ref()
                .and_then(|l| l.reminder.as_ref())
                .filter(|r| r.id == id)
                .ok_or(i.lang().messages().err_reminder_answered)?;
            if !choice.answers(shown.kind) {
                return Err("unknown choice".into());
            }
        }
        self.send(Command::ResolveReminder { id, choice })?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let pending = lock(&self.inner)
                .live
                .as_ref()
                .and_then(|l| l.reminder.as_ref())
                .is_some_and(|r| r.id == id);
            if !pending {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(self.lang().messages().err_choice_not_saved.into())
    }

    /// Saves the employee's reminder settings (local only). Waits (≤ 2 s) until the
    /// runtime reports them. Blocking.
    pub fn set_reminders(&self, input: &RemindersInput) -> Result<(), String> {
        let settings = view::parse_reminders_input(input, self.lang())?;
        self.send(Command::SetReminderSettings(settings.clone()))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let saved = lock(&self.inner)
                .live
                .as_ref()
                .is_some_and(|l| l.reminders.settings == settings);
            if saved {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(self.lang().messages().err_settings_not_saved.into())
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

    /// "My dashboard": `RD_TRACK_DASHBOARD_URL`, else the URL the server gave at
    /// enrollment, else `<server>/me`. Only http(s) URLs are ever opened.
    pub fn dashboard_url(&self) -> Option<String> {
        let web = |u: &str| u.starts_with("https://") || u.starts_with("http://");
        if let Ok(u) = std::env::var("RD_TRACK_DASHBOARD_URL") {
            if web(&u) {
                return Some(u);
            }
        }
        let i = lock(&self.inner);
        if let Some(u) = i.dashboard_url.as_deref().filter(|u| web(u)) {
            return Some(u.to_owned());
        }
        let server = i.server_url.clone()?;
        web(&server).then(|| format!("{}/me", server.trim_end_matches('/')))
    }

    /// Where the updater asks: the enrolled server and this device's credential (G10).
    pub fn update_source(&self) -> Option<(String, String)> {
        let (identity, credential) = setup::load_for_run(&self.paths, self.creds.as_ref()).ok()?;
        Some((identity.server_url, credential))
    }

    /// The runtime is up and no session is open, so an automatic update may restart the app.
    pub fn no_open_session(&self) -> bool {
        let i = lock(&self.inner);
        i.phase == Some(Phase::Running) && i.live.as_ref().is_some_and(|l| l.session.is_none())
    }

    /// Records that an update is ready.
    pub fn set_update(&self, version: Option<String>) {
        lock(&self.inner).update = version;
    }

    /// Remembers what an enrolment link filled in. Ignored once this computer is enrolled:
    /// a link never moves an enrolled computer to another server.
    pub fn set_enroll_prefill(&self, prefill: EnrollPrefill) -> bool {
        let mut i = lock(&self.inner);
        if i.server_url.is_some() && !matches!(i.phase, Some(Phase::Enroll | Phase::Revoked)) {
            return false;
        }
        i.enroll_prefill = Some(prefill);
        true
    }

    /// The language the app writes in now: the person's choice from the server, else
    /// the computer's own.
    pub fn lang(&self) -> Lang {
        lock(&self.inner).lang()
    }

    /// Builds the popover view.
    pub fn view(&self) -> AppView {
        let i = lock(&self.inner);
        let lang = i.lang();
        let m = lang.messages();
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
                lang,
            },
        );
        let tray = TrayState::of(live);
        let session = live.and_then(|l| l.session.as_ref());
        let limit_lines = view::limit_lines(live.and_then(|l| l.limits.as_ref()), lang);
        AppView {
            phase: i.phase.unwrap_or(Phase::Starting),
            error: i.error.clone(),
            tray,
            lang,
            label: match tray {
                TrayState::Tracking => m.label_tracking,
                TrayState::Paused => m.label_paused,
                TrayState::Idle => m.label_idle,
            },
            elapsed: session.map(|s| view::clock(s.tracked_seconds)),
            session_project_id: session.and_then(|s| s.project_id.clone()),
            session_task_id: session.and_then(|s| s.task_id.clone()),
            camera: live.and_then(|l| view::camera_badge(&l.settings, l.session.is_some(), lang)),
            today: format_duration(live.map_or(0, |l| l.today.tracked_seconds)),
            activity: live
                .and_then(|l| l.today.activity_percent())
                .map(|p| lang.percent(p)),
            limit_today: limit_lines.0,
            limit_week: limit_lines.1,
            sync: live
                .map(|l| view::sync_line(l, Utc::now(), lang))
                .unwrap_or_else(|| m.starting.into()),
            banners,
            idle: live
                .and_then(|l| l.idle_prompt.as_ref())
                .map(|p| view::idle_view(p, &i.projects, &Local, lang)),
            reminder: live
                .filter(|_| tray != TrayState::Paused)
                .and_then(|l| l.reminder.as_ref())
                .map(|r| view::reminder_view(r, Utc::now(), &Local, lang)),
            reminders: view::reminders_view(
                &live.map(|l| l.reminders.clone()).unwrap_or_default(),
                &Local,
                lang,
            ),
            can_start: live.is_some_and(|l| {
                l.session.is_none() && l.agent.tracking_unavailable.is_none() && !l.revoked
            }),
            require_project: live.is_some_and(|l| l.settings.session.require_project),
            projects: i.projects.clone(),
            projects_supported: i.projects_supported,
            server_url: i.server_url.clone(),
            enroll_prefill: i.enroll_prefill.clone(),
            deployment: i.deployment.as_ref().map(|d| DeploymentView {
                server_url: d.server.clone(),
            }),
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
            view::tray_text(i.live.as_ref(), project.as_deref(), v.lang)
        };
        let (changed, relabel) = {
            let mut i = lock(&self.inner);
            let next = (v.tray, tooltip.clone(), title.clone());
            let changed = i.tray.as_ref() != Some(&next);
            i.tray = Some(next);
            let relabel = i.tray_lang.is_some_and(|l| l != v.lang);
            i.tray_lang = Some(v.lang);
            (changed, relabel)
        };
        if relabel {
            crate::tray::relabel(app, v.lang);
        }
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
            // The person's language, once a heartbeat has said it (remembered for next start).
            if status.agent.locale_known && status.agent.locale != i.server_locale {
                i.server_locale.clone_from(&status.agent.locale);
                let _ = std::fs::write(
                    locale_file(&self.ctl.paths),
                    i.server_locale.as_deref().unwrap_or_default(),
                );
            }
            i.live = Some(status.clone());
            if status.revoked {
                i.phase = Some(Phase::Revoked);
            }
        }
        self.ctl.emit(&self.app);
    }

    fn notice(&mut self, notice: &Notice) {
        match notice {
            // The panel / card itself comes from `LiveStatus`; bring it into view.
            Notice::IdleReturn { .. } | Notice::Reminder { .. } => {
                crate::tray::show_for_prompt(&self.app);
                return;
            }
            // There are no native notifications: the banner shows in the popover,
            // which opens (without taking focus) so the heads-up is seen.
            Notice::LimitWarning { .. } => crate::tray::show_for_prompt(&self.app),
            _ => {}
        }
        let mut i = lock(&self.ctl.inner);
        let id = i.next_notice;
        i.next_notice += 1;
        i.notices.push((id, notice.clone()));
        if i.notices.len() > 5 {
            i.notices.remove(0);
        }
    }
}
