//! Pure view-model logic for the tray popover: everything the UI shows is computed
//! here from the runtime's [`LiveStatus`], so it is unit tested without a window.

use chrono::{DateTime, Utc};
use rd_agent_core::api::{DeviceProject, LicenseStatus};
use rd_agent_core::describe::{
    describe_collection, format_duration, CollectionItem, NEVER_COLLECTED,
};
use rd_agent_core::platform::PermissionStatus;
use rd_agent_core::policy::PolicySettings;
use rd_agent_core::runtime::{LiveStatus, Notice, PolicyPreview};
use serde::Serialize;

/// Tray icon state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayState {
    /// No open session.
    Idle,
    /// Session `Active` (or briefly `Suspended`).
    Tracking,
    /// Session paused.
    Paused,
}

impl TrayState {
    /// From the runtime status.
    pub fn of(live: Option<&LiveStatus>) -> Self {
        match live
            .and_then(|l| l.session.as_ref())
            .map(|s| s.state.as_str())
        {
            Some("paused") => TrayState::Paused,
            Some(_) => TrayState::Tracking,
            None => TrayState::Idle,
        }
    }
}

/// A banner action the UI turns into a button that invokes `command` with `arg`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BannerAction {
    /// Button label.
    pub label: String,
    /// Tauri command to invoke.
    pub command: String,
    /// Its single string argument (`name` / `id`), if any.
    pub arg: Option<String>,
}

/// One banner above the popover content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Banner {
    /// Stable id (used to dismiss).
    pub id: String,
    /// `info` or `warn`.
    pub kind: &'static str,
    /// Text.
    pub text: String,
    /// Optional action.
    pub action: Option<BannerAction>,
    /// Whether the employee may dismiss it.
    pub dismissible: bool,
}

impl Banner {
    fn new(id: impl Into<String>, kind: &'static str, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind,
            text: text.into(),
            action: None,
            dismissible: true,
        }
    }

    fn action(mut self, label: &str, command: &str, arg: Option<&str>) -> Self {
        self.action = Some(BannerAction {
            label: label.into(),
            command: command.into(),
            arg: arg.map(str::to_owned),
        });
        self
    }

    fn sticky(mut self) -> Self {
        self.dismissible = false;
        self
    }
}

/// `2:14:08`.
pub fn clock(seconds: u64) -> String {
    format!(
        "{}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// `12 s`, `4 min`, `3 h`.
pub fn ago(seconds: i64) -> String {
    let s = seconds.max(0);
    if s < 60 {
        format!("{s} s")
    } else if s < 3600 {
        format!("{} min", s / 60)
    } else {
        format!("{} h", s / 3600)
    }
}

/// The sync line under the popover ("Synced 12 s ago").
pub fn sync_line(live: &LiveStatus, now: DateTime<Utc>) -> String {
    let queued = live.outbox_depth;
    if !live.agent.online {
        return if queued > 0 {
            format!("Offline · {queued} queued")
        } else {
            "Offline".into()
        };
    }
    if live.agent.tracking_unavailable.is_some() {
        return "Not syncing · tracking unavailable".into();
    }
    let since = live.sync.last_success_at.map(|t| (now - t).num_seconds());
    match (since, &live.sync.last_error) {
        (_, Some(_)) if queued > 0 => format!("Sync problem · {queued} queued, retrying"),
        // Nothing to send for a while: say so instead of an ever-growing "ago".
        (Some(s), _) if queued == 0 && s > 300 => "Up to date".into(),
        (Some(s), _) => format!("Synced {} ago", ago(s)),
        (None, _) if queued == 0 => "Up to date".into(),
        (None, _) => "Syncing…".into(),
    }
}

/// The camera badge text when screenshots are on for the session (or `None`).
pub fn camera_badge(settings: &PolicySettings, session_open: bool) -> Option<String> {
    (session_open && settings.screenshots.enabled).then(|| {
        format!(
            "Screenshots on for this project · about every {} min",
            settings.screenshots.interval_minutes
        )
    })
}

/// Whether `new` collects more than `old` (the employee was shown `old` at start).
pub fn expands(old: &PolicySettings, new: &PolicySettings) -> bool {
    let (o, n) = (&old.screenshots, &new.screenshots);
    (!o.enabled && n.enabled)
        || (o.enabled && n.enabled && n.interval_minutes < o.interval_minutes)
        || (o.enabled && n.enabled && n.max_width_px > o.max_width_px)
        || (o.enabled && n.enabled && o.primary_monitor_only && !n.primary_monitor_only)
        || (!old.apps.capture_app_name && new.apps.capture_app_name)
        || (!old.viewers.manager_can_view_screenshots && new.viewers.manager_can_view_screenshots)
}

/// What the "Start a session on …?" notice shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionNotice {
    /// Project (`None` = no project).
    pub project_id: Option<String>,
    /// Task.
    pub task_id: Option<String>,
    /// "Start a session on Client A?"
    pub title: String,
    /// The collected items, in the web's wording.
    pub items: Vec<CollectionItem>,
    /// The not-collected items (shown collapsed).
    pub not_collected: Vec<CollectionItem>,
    /// Closing lines.
    pub footer: Vec<String>,
    /// What is never collected.
    pub never: &'static str,
    /// Set when the project's own policy could not be loaded yet.
    pub warning: Option<String>,
}

/// Builds the session-start notice from the resolved policy preview.
pub fn session_notice(
    preview: &PolicyPreview,
    task_id: Option<String>,
    project_name: Option<&str>,
) -> SessionNotice {
    let s = &preview.settings;
    let (items, not_collected): (Vec<_>, Vec<_>) = describe_collection(s)
        .into_iter()
        .partition(|i| i.collected);
    let title = match (project_name, &preview.project_id) {
        (Some(n), _) => format!("Start a session on {n}?"),
        (None, Some(id)) => format!("Start a session on {id}?"),
        (None, None) => "Start a session without a project?".into(),
    };
    let mut footer = vec!["Nothing is recorded while paused or after you stop.".to_owned()];
    if s.screenshots.enabled {
        footer.push(if s.viewers.manager_can_view_screenshots {
            "Your team manager can view these screenshots; every view is shown to you.".into()
        } else {
            "Managers cannot view your screenshots under this policy.".into()
        });
        footer.push("You can see each screenshot and request its deletion in My dashboard.".into());
    }
    if s.apps.capture_domains || s.apps.capture_window_titles {
        footer.push(
            "This version of the agent does not collect website domains, window titles or URLs."
                .into(),
        );
    }
    let warning = (preview.source != "exact").then(|| {
        let whose = if preview.project_id.is_some() {
            "This project's policy"
        } else {
            "Your organization's policy"
        };
        format!("{whose} could not be loaded yet (offline?). Screenshots stay off until it is; you will be told if that changes.")
    });
    SessionNotice {
        project_id: preview.project_id.clone(),
        task_id,
        title,
        items,
        not_collected,
        footer,
        never: NEVER_COLLECTED,
        warning,
    }
}

/// Inputs to [`banners`] beyond the runtime status.
#[derive(Debug, Clone, Default)]
pub struct BannerContext<'a> {
    /// Notices received from the runtime (id, notice), oldest first.
    pub notices: &'a [(u64, Notice)],
    /// Ids the employee dismissed.
    pub dismissed: &'a [String],
    /// Permissions already prompted for once (only Settings links from then on).
    pub prompted: &'a [&'a str],
    /// The settings change since the session-start notice, if collection expanded.
    pub collection_changed: bool,
    /// Running on the simulated platform.
    pub simulated: bool,
    /// macOS (permission banners link to System Settings).
    pub macos: bool,
    /// An update is ready to install.
    pub update: Option<&'a str>,
}

fn permission_banner(name: &str, text: &str, ctx: &BannerContext<'_>) -> Banner {
    let b = Banner::new(format!("perm:{name}"), "warn", text);
    if !ctx.macos {
        return b;
    }
    if ctx.prompted.contains(&name) {
        b.action(
            "Fix in System Settings",
            "open_permission_settings",
            Some(name),
        )
    } else {
        b.action("Allow…", "request_permission", Some(name))
    }
}

/// Banners for the popover, most important first.
pub fn banners(live: Option<&LiveStatus>, ctx: &BannerContext<'_>) -> Vec<Banner> {
    let mut out = Vec::new();
    if let Some(l) = live {
        if let Some(msg) = &l.agent.tracking_unavailable_message {
            out.push(
                Banner::new("license", "warn", format!("{msg}. Ask your administrator.")).sticky(),
            );
        } else if let Some(li) = &l.agent.license {
            if li.status == LicenseStatus::Grace {
                let until = li
                    .grace_ends_at
                    .map(|t| format!(" until {}", t.format("%-d %b %Y")))
                    .unwrap_or_default();
                out.push(Banner::new(
                    "license-grace",
                    "info",
                    format!("Your organization's subscription is in its grace period{until}. Tracking continues."),
                ));
            }
        }
        let screenshots_relevant = l.settings.screenshots.enabled
            || l.preview
                .as_ref()
                .is_some_and(|p| p.settings.screenshots.enabled);
        if screenshots_relevant && l.permissions.screen_recording == PermissionStatus::Denied {
            out.push(permission_banner(
                "screen_recording",
                "Screenshots for this project need the Screen Recording permission. None are taken until it is granted.",
                ctx,
            ));
        }
        if l.permissions.input_monitoring == PermissionStatus::Denied {
            out.push(permission_banner(
                "input_monitoring",
                "Keyboard and mouse counts need the Input Monitoring permission. Until then minutes are recorded without counts.",
                ctx,
            ));
        }
        if l.session.as_ref().and_then(|s| s.paused_reason)
            == Some(rd_agent_core::events::PauseReason::WorkHours)
        {
            out.push(Banner::new(
                "work-hours",
                "info",
                "Outside your work hours — nothing is recorded until they start again.",
            ));
        }
    }
    if ctx.collection_changed {
        out.push(
            Banner::new(
                "collection-changed",
                "warn",
                "Your organization changed what this session collects. Review it now.",
            )
            .action("Review", "review_collection", None),
        );
    }
    for (id, n) in ctx.notices {
        let b = match n {
            Notice::SessionOverlap { .. } => Banner::new(
                format!("n{id}"),
                "warn",
                "Your session was stopped: another work session is already running for you.",
            ),
            Notice::OutsideWorkHours => continue, // shown from the live status above
            Notice::LicenseUnavailable { .. } | Notice::Revoked => continue,
            Notice::LicenseRestored => {
                Banner::new(format!("n{id}"), "info", "Tracking is available again.")
            }
            Notice::Recovered { resumed: true, .. } => Banner::new(
                format!("n{id}"),
                "info",
                "Your session from before the restart was resumed.",
            ),
            Notice::Recovered { resumed: false, .. } => Banner::new(
                format!("n{id}"),
                "info",
                "A session left open before a restart was closed at the time the agent last ran.",
            ),
        };
        out.push(b);
    }
    if let Some(v) = ctx.update {
        out.push(
            Banner::new("update", "info", format!("Version {v} is ready.")).action(
                "Restart to update",
                "install_update",
                None,
            ),
        );
    }
    if ctx.simulated {
        out.push(Banner::new(
            "simulated",
            "info",
            "Development build: simulated input and screen (no native collectors on this OS).",
        ));
    }
    out.retain(|b| !(b.dismissible && ctx.dismissed.contains(&b.id)));
    out
}

/// Tray tooltip / macOS menu-bar title.
pub fn tray_text(
    live: Option<&LiveStatus>,
    project_name: Option<&str>,
) -> (String, Option<String>) {
    let Some(l) = live else {
        return ("RoundDigital Track".into(), None);
    };
    let Some(s) = &l.session else {
        let t = if l.agent.tracking_unavailable.is_some() {
            "RoundDigital Track — tracking unavailable"
        } else {
            "RoundDigital Track — not tracking"
        };
        return (t.into(), None);
    };
    let what = if s.state == "paused" {
        "Paused"
    } else {
        "Tracking"
    };
    let project = project_name
        .map(str::to_owned)
        .or_else(|| s.project_id.clone())
        .map(|p| format!(" — {p}"))
        .unwrap_or_default();
    let elapsed = format_duration(s.tracked_seconds);
    let camera = if l.settings.screenshots.enabled {
        " · screenshots on"
    } else {
        ""
    };
    (
        format!("{what}{project} · {elapsed}{camera}"),
        Some(elapsed),
    )
}

/// Name of a project from the cached list.
pub fn project_name<'a>(projects: &'a [DeviceProject], id: Option<&str>) -> Option<&'a str> {
    let id = id?;
    projects
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.name.as_str())
}

/// Where to put the popover (physical pixels): centred under a tray icon at the top
/// of the screen (macOS menu bar), or above one at the bottom (Windows taskbar), kept
/// inside the monitor's work area.
pub fn popover_origin(
    tray: (f64, f64, f64, f64),
    window: (f64, f64),
    area: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (tx, ty, tw, th) = tray;
    let (ww, wh) = window;
    let (ax, ay, aw, ah) = area;
    let gap = 6.0;
    let x = (tx + tw / 2.0 - ww / 2.0).clamp(ax, (ax + aw - ww).max(ax));
    let below = ty + th / 2.0 < ay + ah / 2.0;
    let y = if below { ty + th + gap } else { ty - wh - gap };
    (x, y.clamp(ay, (ay + ah - wh).max(ay)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rd_agent_core::api::{LicenseBlock, LicenseInfo};
    use rd_agent_core::platform::Permissions;
    use rd_agent_core::runtime::{AgentStatus, LiveSession, SyncStatus, TodayTotals};

    fn t(s: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap() + chrono::TimeDelta::seconds(s)
    }

    fn live() -> LiveStatus {
        LiveStatus {
            agent: AgentStatus {
                state: "idle".into(),
                session_id: None,
                project_id: None,
                policy_revision: 1,
                policy_source: "exact".into(),
                screenshots_enabled: false,
                idle_threshold_seconds: 300,
                online: true,
                tracking_unavailable: None,
                tracking_unavailable_message: None,
                license: None,
                updated_at: t(0),
            },
            session: None,
            settings: PolicySettings::default(),
            preview: None,
            permissions: Permissions::default(),
            today: TodayTotals::default(),
            sync: SyncStatus::default(),
            outbox_depth: 0,
            revoked: false,
        }
    }

    fn session(state: &str) -> LiveSession {
        LiveSession {
            id: uuid::Uuid::nil(),
            state: state.into(),
            paused_reason: None,
            project_id: Some("p1".into()),
            task_id: None,
            started_at: t(0),
            tracked_seconds: 2 * 3600 + 14 * 60 + 8,
        }
    }

    #[test]
    fn clocks_and_ages() {
        assert_eq!(clock(2 * 3600 + 14 * 60 + 8), "2:14:08");
        assert_eq!(clock(59), "0:00:59");
        assert_eq!(ago(12), "12 s");
        assert_eq!(ago(-3), "0 s");
        assert_eq!(ago(240), "4 min");
        assert_eq!(ago(7300), "2 h");
    }

    #[test]
    fn sync_line_states() {
        let mut l = live();
        assert_eq!(sync_line(&l, t(0)), "Up to date");
        l.outbox_depth = 4;
        assert_eq!(sync_line(&l, t(0)), "Syncing…");
        l.sync.last_success_at = Some(t(0));
        assert_eq!(sync_line(&l, t(12)), "Synced 12 s ago");
        l.outbox_depth = 0;
        assert_eq!(sync_line(&l, t(301)), "Up to date");
        assert_eq!(sync_line(&l, t(300)), "Synced 5 min ago");
        l.outbox_depth = 4;
        l.sync.last_error = Some("http 500".into());
        assert_eq!(sync_line(&l, t(12)), "Sync problem · 4 queued, retrying");
        l.agent.online = false;
        assert_eq!(sync_line(&l, t(12)), "Offline · 4 queued");
        l.outbox_depth = 0;
        assert_eq!(sync_line(&l, t(12)), "Offline");
    }

    #[test]
    fn tray_state_and_text() {
        let mut l = live();
        assert_eq!(TrayState::of(None), TrayState::Idle);
        assert_eq!(TrayState::of(Some(&l)), TrayState::Idle);
        assert_eq!(
            tray_text(Some(&l), None).0,
            "RoundDigital Track — not tracking"
        );
        l.session = Some(session("active"));
        l.settings.screenshots.enabled = true;
        assert_eq!(TrayState::of(Some(&l)), TrayState::Tracking);
        let (tip, title) = tray_text(Some(&l), Some("Client A"));
        assert_eq!(tip, "Tracking — Client A · 2h 14m · screenshots on");
        assert_eq!(title.as_deref(), Some("2h 14m"));
        l.session = Some(session("paused"));
        assert_eq!(TrayState::of(Some(&l)), TrayState::Paused);
        assert!(tray_text(Some(&l), None).0.starts_with("Paused — p1"));
    }

    #[test]
    fn camera_badge_only_with_open_session_and_screenshots() {
        let mut s = PolicySettings::default();
        assert_eq!(camera_badge(&s, true), None);
        s.screenshots.enabled = true;
        assert_eq!(camera_badge(&s, false), None);
        assert_eq!(
            camera_badge(&s, true).as_deref(),
            Some("Screenshots on for this project · about every 15 min")
        );
    }

    #[test]
    fn expansion_detection() {
        let base = PolicySettings::default();
        let mut more = base.clone();
        assert!(!expands(&base, &more));
        more.screenshots.enabled = true;
        assert!(expands(&base, &more));
        assert!(
            !expands(&more, &base),
            "less collection is not an expansion"
        );
        let mut faster = more.clone();
        faster.screenshots.interval_minutes = 10;
        assert!(expands(&more, &faster));
        let mut wider = more.clone();
        wider.screenshots.max_width_px = 1920;
        assert!(expands(&more, &wider));
        let mut viewers = base.clone();
        viewers.viewers.manager_can_view_screenshots = true;
        assert!(expands(&base, &viewers));
    }

    #[test]
    fn notice_lists_collected_items_in_web_wording() {
        let mut s = PolicySettings::default();
        s.screenshots.enabled = true;
        s.viewers.manager_can_view_screenshots = true;
        let p = PolicyPreview {
            project_id: Some("p1".into()),
            source: "exact".into(),
            revision: 3,
            settings: s,
        };
        let n = session_notice(&p, Some("t1".into()), Some("Client A"));
        assert_eq!(n.title, "Start a session on Client A?");
        let texts: Vec<_> = n.items.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "When your session starts, pauses and stops",
                "How many keyboard and mouse events happen each minute",
                "The name of the app in front",
                "Screenshots"
            ]
        );
        assert_eq!(n.not_collected.len(), 2);
        assert!(n.warning.is_none());
        assert!(n
            .footer
            .iter()
            .any(|f| f.contains("every view is shown to you")));
        assert_eq!(n.task_id.as_deref(), Some("t1"));

        let fallback = PolicyPreview {
            project_id: None,
            source: "base_fallback".into(),
            revision: 1,
            settings: PolicySettings::default(),
        };
        let n = session_notice(&fallback, None, None);
        assert_eq!(n.title, "Start a session without a project?");
        assert!(n.warning.is_some());
        assert_eq!(n.footer.len(), 1);
    }

    #[test]
    fn banners_cover_license_permissions_notices_and_dismissal() {
        let mut l = live();
        l.agent.tracking_unavailable = Some(LicenseBlock::SeatUnavailable);
        l.agent.tracking_unavailable_message = Some(LicenseBlock::SeatUnavailable.message().into());
        l.settings.screenshots.enabled = true;
        l.permissions.screen_recording = PermissionStatus::Denied;
        let notices = vec![(7, Notice::LicenseRestored), (8, Notice::OutsideWorkHours)];
        let dismissed = vec!["license".to_owned()];
        let ctx = BannerContext {
            notices: &notices,
            dismissed: &dismissed,
            macos: true,
            ..Default::default()
        };
        let b = banners(Some(&l), &ctx);
        let ids: Vec<_> = b.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(
            ids,
            ["license", "perm:screen_recording", "n7"],
            "licence is sticky"
        );
        assert_eq!(b[1].action.as_ref().unwrap().command, "request_permission");

        let prompted = ["screen_recording"];
        let dismissed = vec!["n7".to_owned()];
        let ctx = BannerContext {
            notices: &notices,
            dismissed: &dismissed,
            prompted: &prompted,
            macos: true,
            simulated: true,
            ..Default::default()
        };
        let b = banners(Some(&l), &ctx);
        assert_eq!(
            b[1].action.as_ref().unwrap().command,
            "open_permission_settings",
            "never a second prompt"
        );
        assert!(b.iter().all(|b| b.id != "n7"));
        assert_eq!(b.last().unwrap().id, "simulated");

        let mut l = live();
        l.agent.license = Some(LicenseInfo {
            status: LicenseStatus::Grace,
            grace_ends_at: Some(t(86_400 * 3)),
        });
        let b = banners(Some(&l), &BannerContext::default());
        assert_eq!(b[0].id, "license-grace");
        assert!(b[0].text.contains("31 Oct 2026"));
    }

    #[test]
    fn popover_sits_under_menu_bar_or_above_taskbar() {
        // macOS: tray at the top.
        let (x, y) = popover_origin(
            (1500.0, 0.0, 40.0, 48.0),
            (720.0, 1040.0),
            (0.0, 0.0, 2880.0, 1800.0),
        );
        assert_eq!((x, y), (1160.0, 54.0));
        // Windows: tray at the bottom right, clamped to the work area.
        let (x, y) = popover_origin(
            (1880.0, 1040.0, 32.0, 40.0),
            (360.0, 520.0),
            (0.0, 0.0, 1920.0, 1040.0),
        );
        assert_eq!(x, 1560.0);
        assert_eq!(y, 514.0);
    }
}
