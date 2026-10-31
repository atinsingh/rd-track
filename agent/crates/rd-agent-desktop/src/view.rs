//! Pure view-model logic for the tray popover: everything the UI shows is computed
//! here from the runtime's [`LiveStatus`], so it is unit tested without a window.

use chrono::{DateTime, Datelike, TimeZone, Utc};
use rd_agent_core::api::{DeviceProject, LicenseStatus};
use rd_agent_core::describe::{describe_collection_in, format_duration, CollectionItem};
use rd_agent_core::events::IdleDecision;
use rd_agent_core::i18n::{fill, translate, Lang};
use rd_agent_core::limits::{LimitScope, LimitSummary};
use rd_agent_core::platform::PermissionStatus;
use rd_agent_core::policy::PolicySettings;
use rd_agent_core::reminders::{
    parse_hhmm, HoursSource, MyHours, ReminderChoice, ReminderKind, ReminderSettings,
};
use rd_agent_core::runtime::{
    IdlePrompt, LiveStatus, Notice, PolicyPreview, ReminderPrompt, ReminderStatus,
};
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
    /// Text (the title when there is a `detail` line).
    pub text: String,
    /// One line of why, under the title.
    pub detail: Option<String>,
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
            detail: None,
            action: None,
            dismissible: true,
        }
    }

    fn detail(mut self, line: &str) -> Self {
        self.detail = Some(line.into());
        self
    }

    /// The only button acknowledges (dismisses) the banner.
    fn acknowledge(mut self, label: &str) -> Self {
        let id = self.id.clone();
        self = self.action(label, "dismiss_banner", Some(&id));
        self.dismissible = false;
        self
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
pub fn sync_line(live: &LiveStatus, now: DateTime<Utc>, lang: Lang) -> String {
    let m = lang.messages();
    let queued = live.outbox_depth;
    let n = queued.to_string();
    if !live.agent.online {
        return if queued > 0 {
            fill(m.sync_offline_queued, &[("n", &n)])
        } else {
            m.sync_offline.into()
        };
    }
    if live.agent.tracking_unavailable.is_some() {
        return m.sync_unavailable.into();
    }
    let since = live.sync.last_success_at.map(|t| (now - t).num_seconds());
    match (since, &live.sync.last_error) {
        (_, Some(_)) if queued > 0 => fill(m.sync_problem, &[("n", &n)]),
        // Nothing to send for a while: say so instead of an ever-growing "ago".
        (Some(s), _) if queued == 0 && s > 300 => m.sync_up_to_date.into(),
        (Some(s), _) => fill(m.sync_synced, &[("ago", &ago(s))]),
        (None, _) if queued == 0 => m.sync_up_to_date.into(),
        (None, _) => m.syncing.into(),
    }
}

/// The camera badge text when screenshots are on for the session (or `None`).
pub fn camera_badge(settings: &PolicySettings, session_open: bool, lang: Lang) -> Option<String> {
    (session_open && settings.screenshots.enabled).then(|| {
        fill(
            lang.messages().camera_badge,
            &[("n", &settings.screenshots.interval_minutes.to_string())],
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
    lang: Lang,
) -> SessionNotice {
    let m = lang.messages();
    let s = &preview.settings;
    let (items, not_collected): (Vec<_>, Vec<_>) = describe_collection_in(s, lang)
        .into_iter()
        .partition(|i| i.collected);
    let title = match (project_name, &preview.project_id) {
        (Some(n), _) => fill(m.notice_title_project, &[("name", n)]),
        (None, Some(id)) => fill(m.notice_title_project, &[("name", id)]),
        (None, None) => m.notice_title_none.into(),
    };
    let mut footer = vec![m.notice_paused.to_owned()];
    if s.screenshots.enabled {
        footer.push(if s.viewers.manager_can_view_screenshots {
            m.notice_manager_views.into()
        } else {
            m.notice_managers_cannot.into()
        });
        footer.push(m.notice_see_each.into());
    }
    if s.apps.capture_app_name && s.apps.capture_domains {
        footer.push(m.notice_domains.into());
    }
    if s.apps.capture_window_titles {
        footer.push(m.notice_no_titles.into());
    }
    let warning = (preview.source != "exact").then(|| {
        if preview.project_id.is_some() {
            m.notice_warning_project.to_owned()
        } else {
            m.notice_warning_org.to_owned()
        }
    });
    SessionNotice {
        project_id: preview.project_id.clone(),
        task_id,
        title,
        items,
        not_collected,
        footer,
        never: m.never_collected,
        warning,
    }
}

/// "28 min", "1 h", "1 h 5 min": an idle span, rounded to the minute (at least 1).
pub fn away_duration(seconds: u32) -> String {
    let minutes = ((seconds + 30) / 60).max(1);
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// The "Welcome back" panel for an unanswered idle-return prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdleView {
    /// Prompt id, passed back to `resolve_idle`.
    pub id: String,
    /// "You were away for 28 min".
    pub title: String,
    /// "09:12 – 09:41" (local time; with dates when the span crosses midnight).
    pub times: String,
    /// The session's project name, or "No project".
    pub project: String,
    /// "Keep 28 min".
    pub keep_label: String,
    /// "Remove 28 min".
    pub discard_label: String,
    /// "Move {duration}" — a correction, approved first where the organisation reviews them.
    pub reassign_label: String,
    /// Projects the time can be moved to (the session's own project left out).
    pub targets: Vec<DeviceProject>,
}

/// Builds the idle-return panel; times are shown in `tz` (the device's local zone).
pub fn idle_view<Tz: TimeZone>(
    prompt: &IdlePrompt,
    projects: &[DeviceProject],
    tz: &Tz,
    lang: Lang,
) -> IdleView
where
    Tz::Offset: std::fmt::Display,
{
    let m = lang.messages();
    let duration = away_duration(prompt.seconds);
    let d = [("duration", duration.as_str())];
    let (from, to) = (
        prompt.started_at.with_timezone(tz),
        prompt.ended_at.with_timezone(tz),
    );
    let times = if from.date_naive() == to.date_naive() {
        format!("{} – {}", from.format("%H:%M"), to.format("%H:%M"))
    } else {
        format!(
            "{} {} – {} {}",
            lang.day_month(from.day(), from.month()),
            from.format("%H:%M"),
            lang.day_month(to.day(), to.month()),
            to.format("%H:%M")
        )
    };
    let project = match prompt.project_id.as_deref() {
        Some(id) => project_name(projects, Some(id)).unwrap_or(id).to_owned(),
        None => m.no_project.to_owned(),
    };
    IdleView {
        id: prompt.id.to_string(),
        title: fill(m.idle_title, &d),
        times,
        project,
        keep_label: fill(m.idle_keep, &d),
        discard_label: fill(m.idle_remove, &d),
        reassign_label: fill(m.idle_move, &d),
        targets: projects
            .iter()
            .filter(|p| Some(p.id.as_str()) != prompt.project_id.as_deref())
            .cloned()
            .collect(),
    }
}

/// Parses the popover's choice (`keep`, `discard`, `reassign`).
pub fn parse_idle_decision(s: &str) -> Option<IdleDecision> {
    match s {
        "keep" => Some(IdleDecision::Keep),
        "discard" => Some(IdleDecision::Discard),
        "reassign" => Some(IdleDecision::Reassign),
        _ => None,
    }
}

/// Checks a `reassign` target against the project list the popover offered: the
/// project must be listed (and not the session's own), the task one of its tasks.
pub fn check_idle_target(
    view: &IdleView,
    project_id: Option<&str>,
    task_id: Option<&str>,
    lang: Lang,
) -> Result<(), String> {
    let m = lang.messages();
    let pid = project_id.ok_or(m.idle_choose_project)?;
    let p = view
        .targets
        .iter()
        .find(|p| p.id == pid)
        .ok_or(m.idle_choose_listed)?;
    if let Some(t) = task_id {
        if !p.tasks.iter().any(|x| x.id == t) {
            return Err(m.idle_choose_task.into());
        }
    }
    Ok(())
}

/// "8 h", "7 h 30 min": a limit, in hours.
pub fn limit_hours(minutes: u32) -> String {
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// Title of a work-limit banner: "80% of today's 8 h limit", "You've reached this
/// week's 40 h limit".
pub fn limit_title(scope: LimitScope, percent: u8, limit_minutes: u32, lang: Lang) -> String {
    let m = lang.messages();
    let limit = limit_hours(limit_minutes);
    let pct = lang.percent(percent);
    let vars = [("limit", limit.as_str()), ("percent", pct.as_str())];
    let template = match (scope, percent >= 100) {
        (LimitScope::Daily, true) => m.limit_reached_today,
        (LimitScope::Weekly, true) => m.limit_reached_week,
        (LimitScope::Daily, false) => m.limit_pct_today,
        (LimitScope::Weekly, false) => m.limit_pct_week,
    };
    fill(template, &vars)
}

/// "8h" / "7h 30m": a limit in the popover's duration style.
fn short_hours(minutes: u32) -> String {
    match (minutes / 60, minutes % 60) {
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m:02}m"),
    }
}

/// The popover's limit lines: "5h 12m of 8h today", "31h 05m of 40h this week".
pub fn limit_lines(summary: Option<&LimitSummary>, lang: Lang) -> (Option<String>, Option<String>) {
    let Some(s) = summary else {
        return (None, None);
    };
    let m = lang.messages();
    let line = |p: &rd_agent_core::limits::LimitProgress, template: &str| {
        fill(
            template,
            &[
                ("worked", &format_duration(p.worked_seconds)),
                ("limit", &short_hours(p.limit_minutes)),
            ],
        )
    };
    (
        s.daily.as_ref().map(|p| line(p, m.limit_line_today)),
        s.weekly.as_ref().map(|p| line(p, m.limit_line_week)),
    )
}

/// One button of the reminder card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReminderButton {
    /// Label.
    pub label: &'static str,
    /// Passed back to `resolve_reminder`.
    pub choice: &'static str,
}

/// The reminder card (title, one line, two buttons).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReminderView {
    /// Prompt id, passed back to `resolve_reminder`.
    pub id: String,
    /// `start`, `stop`, `still_tracking`.
    pub kind: ReminderKind,
    /// "Ready to start tracking?"
    pub title: String,
    /// "Your hours started at 09:00."
    pub detail: String,
    /// "Start tracking" / "Stop tracking".
    pub primary: ReminderButton,
    /// "Not today" / "Keep tracking".
    pub secondary: ReminderButton,
}

/// Builds the reminder card; times are shown in `tz` (the device's local zone), with
/// the date when it is not today's.
pub fn reminder_view<Tz: TimeZone>(
    prompt: &ReminderPrompt,
    now: DateTime<Utc>,
    tz: &Tz,
    lang: Lang,
) -> ReminderView
where
    Tz::Offset: std::fmt::Display,
{
    let m = lang.messages();
    let today = now.with_timezone(tz).date_naive();
    let time = |t: DateTime<Utc>| {
        let local = t.with_timezone(tz);
        if local.date_naive() == today {
            local.format("%H:%M").to_string()
        } else {
            format!(
                "{} {}",
                lang.day_month(local.day(), local.month()),
                local.format("%H:%M")
            )
        }
    };
    let shift = prompt.source == HoursSource::Organization;
    let at = |t: DateTime<Utc>, shift_text: &str, hours_text: &str| {
        fill(
            if shift { shift_text } else { hours_text },
            &[("time", &time(t))],
        )
    };
    let (stop, keep) = (
        ReminderButton {
            label: m.rem_stop,
            choice: "stop",
        },
        ReminderButton {
            label: m.rem_keep,
            choice: "keep",
        },
    );
    let (title, detail, primary, secondary) = match prompt.kind {
        ReminderKind::Start => (
            m.rem_ready.to_owned(),
            at(
                prompt.hours_start.unwrap_or(prompt.hours_end),
                m.rem_shift_started,
                m.rem_hours_started,
            ),
            ReminderButton {
                label: m.rem_start,
                choice: "start",
            },
            ReminderButton {
                label: m.rem_not_today,
                choice: "not_today",
            },
        ),
        ReminderKind::Stop => (
            at(
                prompt.hours_end,
                m.rem_shift_ended_title,
                m.rem_hours_ended_title,
            ),
            m.rem_session_still.to_owned(),
            stop,
            keep,
        ),
        ReminderKind::StillTracking => (
            m.rem_still.to_owned(),
            at(prompt.hours_end, m.rem_shift_ended, m.rem_hours_ended),
            stop,
            keep,
        ),
    };
    ReminderView {
        id: prompt.id.to_string(),
        kind: prompt.kind,
        title,
        detail,
        primary,
        secondary,
    }
}

/// Parses the reminder card's choice.
pub fn parse_reminder_choice(s: &str) -> Option<ReminderChoice> {
    match s {
        "start" => Some(ReminderChoice::Start),
        "not_today" => Some(ReminderChoice::NotToday),
        "stop" => Some(ReminderChoice::Stop),
        "keep" => Some(ReminderChoice::Keep),
        _ => None,
    }
}

/// The "Reminders" settings section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemindersView {
    /// Master switch.
    pub enabled: bool,
    /// Start reminder.
    pub start: bool,
    /// Stop reminder.
    pub stop: bool,
    /// "Still tracking?"
    pub still_tracking: bool,
    /// "09:00".
    pub my_start: String,
    /// "17:30".
    pub my_end: String,
    /// ISO weekdays of my hours.
    pub my_days: Vec<u8>,
    /// Shown instead of the hours editor when the organization's schedule applies.
    pub schedule_note: Option<&'static str>,
    /// "Today 09:00–17:30" / "No reminders today".
    pub today: String,
}

/// Builds the settings section; times in `tz`.
pub fn reminders_view<Tz: TimeZone>(status: &ReminderStatus, tz: &Tz, lang: Lang) -> RemindersView
where
    Tz::Offset: std::fmt::Display,
{
    let m = lang.messages();
    let s = &status.settings;
    let today = match &status.window {
        Some(w) => fill(
            m.rem_today,
            &[
                (
                    "from",
                    &w.start.with_timezone(tz).format("%H:%M").to_string(),
                ),
                ("to", &w.end.with_timezone(tz).format("%H:%M").to_string()),
            ],
        ),
        None => m.rem_none_today.to_owned(),
    };
    RemindersView {
        enabled: s.enabled,
        start: s.start,
        stop: s.stop,
        still_tracking: s.still_tracking,
        my_start: s.my_hours.start.format("%H:%M").to_string(),
        my_end: s.my_hours.end.format("%H:%M").to_string(),
        my_days: s.my_hours.days.clone(),
        schedule_note: status.schedule_sets_hours.then_some(m.rem_schedule_note),
        today,
    }
}

/// What the settings section sends back.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct RemindersInput {
    /// Master switch.
    pub enabled: bool,
    /// Start reminder.
    pub start: bool,
    /// Stop reminder.
    pub stop: bool,
    /// "Still tracking?"
    pub still_tracking: bool,
    /// `HH:MM`.
    pub my_start: String,
    /// `HH:MM`.
    pub my_end: String,
    /// ISO weekdays.
    pub my_days: Vec<u8>,
}

/// Checks the section's input; the error is shown under it.
pub fn parse_reminders_input(
    input: &RemindersInput,
    lang: Lang,
) -> Result<ReminderSettings, String> {
    let m = lang.messages();
    let start = parse_hhmm(&input.my_start).ok_or(m.rem_start_time)?;
    let end = parse_hhmm(&input.my_end).ok_or(m.rem_end_time)?;
    ReminderSettings {
        enabled: input.enabled,
        start: input.start,
        stop: input.stop,
        still_tracking: input.still_tracking,
        my_hours: MyHours {
            start,
            end,
            days: input.my_days.clone(),
        },
    }
    .validated()
    // The checks are written in English; say them in the person's language.
    .map_err(|e| translate(lang, e).to_owned())
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
    /// The language to write in.
    pub lang: Lang,
}

fn permission_banner(name: &str, text: &str, ctx: &BannerContext<'_>) -> Banner {
    let b = Banner::new(format!("perm:{name}"), "warn", text);
    if !ctx.macos {
        return b;
    }
    let m = ctx.lang.messages();
    if ctx.prompted.contains(&name) {
        b.action(m.perm_fix, "open_permission_settings", Some(name))
    } else {
        b.action(m.perm_allow, "request_permission", Some(name))
    }
}

/// Banners for the popover, most important first.
pub fn banners(live: Option<&LiveStatus>, ctx: &BannerContext<'_>) -> Vec<Banner> {
    let m = ctx.lang.messages();
    let mut out = Vec::new();
    let paused = TrayState::of(live) == TrayState::Paused;
    if let Some(l) = live {
        let unavailable = l
            .agent
            .tracking_unavailable
            .map(|b| b.message_in(ctx.lang).to_owned())
            .or_else(|| l.agent.tracking_unavailable_message.clone());
        if let Some(msg) = unavailable {
            out.push(
                Banner::new("license", "warn", fill(m.license_ask, &[("message", &msg)])).sticky(),
            );
        } else if let Some(li) = &l.agent.license {
            if li.status == LicenseStatus::Grace {
                let until = li
                    .grace_ends_at
                    .map(|t| {
                        let date =
                            format!("{} {}", ctx.lang.day_month(t.day(), t.month()), t.year());
                        fill(m.license_grace_until, &[("date", &date)])
                    })
                    .unwrap_or_default();
                out.push(Banner::new(
                    "license-grace",
                    "info",
                    fill(m.license_grace, &[("until", &until)]),
                ));
            }
        }
        let screenshots_relevant = l.settings.screenshots.enabled
            || l.preview
                .as_ref()
                .is_some_and(|p| p.settings.screenshots.enabled);
        if screenshots_relevant && l.permissions.screen_recording == PermissionStatus::Denied {
            out.push(permission_banner("screen_recording", m.perm_screen, ctx));
        }
        if l.permissions.input_monitoring == PermissionStatus::Denied {
            out.push(permission_banner("input_monitoring", m.perm_input, ctx));
        }
        // Domains are wanted but no browser can give them.
        if l.session.is_some()
            && l.settings.apps.capture_app_name
            && l.settings.apps.capture_domains
            && l.browser_extensions.is_empty()
            && !ctx.simulated
        {
            out.push(Banner::new(
                "browser-extension",
                "info",
                m.browser_ext_missing,
            ));
        }
        if l.session.as_ref().and_then(|s| s.paused_reason)
            == Some(rd_agent_core::events::PauseReason::WorkHours)
        {
            out.push(Banner::new("work-hours", "info", m.work_hours));
        }
    }
    if ctx.collection_changed {
        out.push(
            Banner::new("collection-changed", "warn", m.collection_changed).action(
                m.review,
                "review_collection",
                None,
            ),
        );
    }
    for (id, n) in ctx.notices {
        let b = match n {
            Notice::SessionOverlap { .. } => Banner::new(format!("n{id}"), "warn", m.overlap),
            Notice::OutsideWorkHours => continue, // shown from the live status above
            Notice::LicenseUnavailable { .. } | Notice::Revoked => continue,
            // Shown as its own panel from `LiveStatus::idle_prompt`.
            Notice::IdleReturn { .. } => continue,
            // Shown as the reminder card from `LiveStatus::reminder`.
            Notice::Reminder { .. } => continue,
            // Nothing about limits is shown while a session is paused.
            Notice::LimitWarning { .. } if paused => continue,
            Notice::LimitWarning {
                scope,
                percent,
                limit_minutes,
                ..
            } => Banner::new(
                format!("n{id}"),
                "info",
                limit_title(*scope, *percent, *limit_minutes, ctx.lang),
            )
            .detail(m.limit_detail)
            .acknowledge(m.got_it),
            Notice::LicenseRestored => Banner::new(format!("n{id}"), "info", m.license_restored),
            Notice::Recovered { resumed: true, .. } => {
                Banner::new(format!("n{id}"), "info", m.recovered_resumed)
            }
            Notice::Recovered { resumed: false, .. } => {
                Banner::new(format!("n{id}"), "info", m.recovered_closed)
            }
        };
        out.push(b);
    }
    if let Some(v) = ctx.update {
        out.push(
            Banner::new("update", "info", fill(m.update_ready, &[("version", v)])).action(
                m.update_restart,
                "install_update",
                None,
            ),
        );
    }
    if ctx.simulated {
        out.push(Banner::new("simulated", "info", m.simulated));
    }
    out.retain(|b| !(b.dismissible && ctx.dismissed.contains(&b.id)));
    out
}

/// Tray tooltip / macOS menu-bar title.
pub fn tray_text(
    live: Option<&LiveStatus>,
    project_name: Option<&str>,
    lang: Lang,
) -> (String, Option<String>) {
    let m = lang.messages();
    let Some(l) = live else {
        return ("RoundDigital Track".into(), None);
    };
    let Some(s) = &l.session else {
        let t = if l.agent.tracking_unavailable.is_some() {
            m.tray_unavailable
        } else {
            m.tray_not_tracking
        };
        return (t.into(), None);
    };
    let what = if s.state == "paused" {
        m.tray_paused
    } else {
        m.tray_tracking
    };
    let project = project_name
        .map(str::to_owned)
        .or_else(|| s.project_id.clone())
        .map(|p| format!(" — {p}"))
        .unwrap_or_default();
    let elapsed = format_duration(s.tracked_seconds);
    let camera = if l.settings.screenshots.enabled {
        m.tray_screenshots
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
    use rd_agent_core::i18n::Lang;
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
                locale: None,
                locale_known: false,
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
            idle_prompt: None,
            limits: None,
            reminder: None,
            browser_extensions: Vec::new(),
            reminders: ReminderStatus::default(),
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
        assert_eq!(sync_line(&l, t(0), Lang::En), "Up to date");
        l.outbox_depth = 4;
        assert_eq!(sync_line(&l, t(0), Lang::En), "Syncing…");
        l.sync.last_success_at = Some(t(0));
        assert_eq!(sync_line(&l, t(12), Lang::En), "Synced 12 s ago");
        l.outbox_depth = 0;
        assert_eq!(sync_line(&l, t(301), Lang::En), "Up to date");
        assert_eq!(sync_line(&l, t(300), Lang::En), "Synced 5 min ago");
        l.outbox_depth = 4;
        l.sync.last_error = Some("http 500".into());
        assert_eq!(
            sync_line(&l, t(12), Lang::En),
            "Sync problem · 4 queued, retrying"
        );
        l.agent.online = false;
        assert_eq!(sync_line(&l, t(12), Lang::En), "Offline · 4 queued");
        l.outbox_depth = 0;
        assert_eq!(sync_line(&l, t(12), Lang::En), "Offline");
    }

    #[test]
    fn writes_in_the_persons_language() {
        let mut l = live();
        l.outbox_depth = 4;
        l.agent.online = false;
        assert_eq!(sync_line(&l, t(12), Lang::Fr), "Hors ligne · 4 en attente");
        assert_eq!(
            limit_title(LimitScope::Daily, 80, 480, Lang::Fr),
            "80\u{a0}% de la limite de 8 h d’aujourd’hui"
        );
        assert_eq!(
            limit_title(LimitScope::Weekly, 100, 2400, Lang::En),
            "You've reached this week's 40 h limit"
        );
        let (tooltip, _) = tray_text(Some(&l), None, Lang::Fr);
        assert_eq!(tooltip, "RoundDigital Track — aucun suivi");
        let err = parse_reminders_input(
            &RemindersInput {
                enabled: true,
                start: true,
                stop: true,
                still_tracking: true,
                my_start: "17:00".into(),
                my_end: "09:00".into(),
                my_days: vec![1],
            },
            Lang::Fr,
        )
        .unwrap_err();
        assert_eq!(err, "La fin de vos heures doit être après le début.");
    }

    #[test]
    fn tray_state_and_text() {
        let mut l = live();
        assert_eq!(TrayState::of(None), TrayState::Idle);
        assert_eq!(TrayState::of(Some(&l)), TrayState::Idle);
        assert_eq!(
            tray_text(Some(&l), None, Lang::En).0,
            "RoundDigital Track — not tracking"
        );
        l.session = Some(session("active"));
        l.settings.screenshots.enabled = true;
        assert_eq!(TrayState::of(Some(&l)), TrayState::Tracking);
        let (tip, title) = tray_text(Some(&l), Some("Client A"), Lang::En);
        assert_eq!(tip, "Tracking — Client A · 2h 14m · screenshots on");
        assert_eq!(title.as_deref(), Some("2h 14m"));
        l.session = Some(session("paused"));
        assert_eq!(TrayState::of(Some(&l)), TrayState::Paused);
        assert!(tray_text(Some(&l), None, Lang::En)
            .0
            .starts_with("Paused — p1"));
    }

    #[test]
    fn camera_badge_only_with_open_session_and_screenshots() {
        let mut s = PolicySettings::default();
        assert_eq!(camera_badge(&s, true, Lang::En), None);
        s.screenshots.enabled = true;
        assert_eq!(camera_badge(&s, false, Lang::En), None);
        assert_eq!(
            camera_badge(&s, true, Lang::En).as_deref(),
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
    fn website_domains_are_explained_and_a_missing_extension_is_flagged() {
        let mut s = PolicySettings::default();
        s.apps.capture_domains = true;
        let p = PolicyPreview {
            project_id: None,
            source: "exact".into(),
            revision: 3,
            settings: s.clone(),
        };
        let n = session_notice(&p, None, None, Lang::En);
        assert!(n
            .footer
            .iter()
            .any(|f| f.contains("the domain alone (e.g. github.com)")));
        assert!(!n.footer.iter().any(|f| f.contains("window titles")));

        let mut l = live();
        l.settings = s;
        l.session = Some(session("active"));
        let has = |l: &LiveStatus| {
            banners(Some(l), &BannerContext::default())
                .iter()
                .any(|b| b.id == "browser-extension")
        };
        assert!(has(&l));
        l.browser_extensions = vec![rd_agent_core::browser::BrowserFamily::Firefox];
        assert!(!has(&l));
        l.browser_extensions.clear();
        l.session = None;
        assert!(!has(&l), "only while a session is open");
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
        let n = session_notice(&p, Some("t1".into()), Some("Client A"), Lang::En);
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
        let n = session_notice(&fallback, None, None, Lang::En);
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

    fn prompt(seconds: u32, project: Option<&str>) -> IdlePrompt {
        serde_json::from_value(serde_json::json!({
            "id": "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
            "session_id": "00000000-0000-0000-0000-000000000000",
            "started_at": "2026-10-28T09:12:30Z",
            "ended_at": "2026-10-28T09:41:00Z",
            "seconds": seconds,
            "project_id": project,
            "task_id": null
        }))
        .unwrap()
    }

    fn projects() -> Vec<DeviceProject> {
        serde_json::from_value(serde_json::json!([
            {"id": "p1", "name": "Client A"},
            {"id": "p2", "name": "Client B", "tasks": [{"id": "t1", "name": "Design"}]},
        ]))
        .unwrap()
    }

    #[test]
    fn away_durations_round_to_the_minute() {
        assert_eq!(away_duration(29), "1 min");
        assert_eq!(away_duration(60), "1 min");
        assert_eq!(away_duration(1710), "29 min");
        assert_eq!(away_duration(1689), "28 min");
        assert_eq!(away_duration(3600), "1 h");
        assert_eq!(away_duration(3900), "1 h 5 min");
    }

    #[test]
    fn idle_panel_wording_times_and_targets() {
        let v = idle_view(&prompt(1710, Some("p1")), &projects(), &Utc, Lang::En);
        assert_eq!(v.id, "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b");
        assert_eq!(v.title, "You were away for 29 min");
        assert_eq!(v.times, "09:12 – 09:41");
        assert_eq!(v.project, "Client A");
        assert_eq!(v.keep_label, "Keep 29 min");
        assert_eq!(v.discard_label, "Remove 29 min");
        assert_eq!(v.reassign_label, "Move 29 min");
        let ids: Vec<_> = v.targets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["p2"], "the session's own project is not a target");

        let v = idle_view(&prompt(1710, None), &projects(), &Utc, Lang::En);
        assert_eq!(v.project, "No project");
        assert_eq!(v.targets.len(), 2);
        let v = idle_view(&prompt(1710, Some("p9")), &[], &Utc, Lang::En);
        assert_eq!(v.project, "p9", "unknown project: show its id");

        // Shown in the device's zone, with dates when the span crosses midnight.
        let mut p = prompt(36_000, None);
        p.started_at = Utc.with_ymd_and_hms(2026, 10, 28, 22, 10, 0).unwrap();
        p.ended_at = Utc.with_ymd_and_hms(2026, 10, 29, 8, 10, 0).unwrap();
        let riga = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        assert_eq!(idle_view(&p, &[], &riga, Lang::En).times, "00:10 – 10:10");
        assert_eq!(
            idle_view(&p, &[], &Utc, Lang::En).times,
            "28 Oct 22:10 – 29 Oct 08:10"
        );
    }

    #[test]
    fn idle_choices_and_targets_are_checked() {
        assert_eq!(parse_idle_decision("keep"), Some(IdleDecision::Keep));
        assert_eq!(parse_idle_decision("discard"), Some(IdleDecision::Discard));
        assert_eq!(
            parse_idle_decision("reassign"),
            Some(IdleDecision::Reassign)
        );
        assert_eq!(parse_idle_decision("delete"), None);
        let v = idle_view(&prompt(600, Some("p1")), &projects(), &Utc, Lang::En);
        assert!(check_idle_target(&v, Some("p2"), None, Lang::En).is_ok());
        assert!(check_idle_target(&v, Some("p2"), Some("t1"), Lang::En).is_ok());
        assert!(check_idle_target(&v, None, None, Lang::En).is_err());
        assert!(
            check_idle_target(&v, Some("p1"), None, Lang::En).is_err(),
            "own project"
        );
        assert!(check_idle_target(&v, Some("zz"), None, Lang::En).is_err());
        assert!(check_idle_target(&v, Some("p2"), Some("t9"), Lang::En).is_err());
    }

    #[test]
    fn idle_return_notice_is_not_a_banner() {
        let notices = vec![(
            3,
            Notice::IdleReturn {
                id: uuid::Uuid::nil(),
                started_at: t(0),
                ended_at: t(600),
                seconds: 600,
                project_id: None,
            },
        )];
        let ctx = BannerContext {
            notices: &notices,
            ..Default::default()
        };
        assert!(banners(Some(&live()), &ctx).is_empty());
    }

    fn limit_notice(scope: LimitScope, percent: u8, limit_minutes: u32) -> Notice {
        Notice::LimitWarning {
            id: "x".into(),
            scope,
            percent,
            limit_minutes,
            worked_seconds: 0,
        }
    }

    #[test]
    fn limit_banners_are_a_title_one_line_and_got_it() {
        let notices = vec![
            (1, limit_notice(LimitScope::Daily, 80, 480)),
            (2, limit_notice(LimitScope::Weekly, 100, 2400)),
            (3, limit_notice(LimitScope::Daily, 100, 450)),
        ];
        let ctx = BannerContext {
            notices: &notices,
            ..Default::default()
        };
        let mut l = live();
        l.session = Some(session("active"));
        let b = banners(Some(&l), &ctx);
        let texts: Vec<_> = b.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "80% of today's 8 h limit",
                "You've reached this week's 40 h limit",
                "You've reached today's 7 h 30 min limit"
            ]
        );
        for x in &b {
            assert_eq!(x.kind, "info", "a heads-up, not a warning");
            assert_eq!(
                x.detail.as_deref(),
                Some(
                    "Tracking continues — this is a heads-up from your organization's work limits."
                )
            );
            let a = x.action.as_ref().unwrap();
            assert_eq!(
                (a.label.as_str(), a.command.as_str()),
                ("Got it", "dismiss_banner")
            );
            assert_eq!(a.arg.as_deref(), Some(x.id.as_str()));
            assert!(!x.dismissible, "one action only");
        }
        // Nothing about limits while paused.
        l.session = Some(session("paused"));
        assert!(banners(Some(&l), &ctx).is_empty());
        // Not tracking (the session stopped after the warning): still listed until "Got it".
        l.session = None;
        assert_eq!(banners(Some(&l), &ctx).len(), 3);
    }

    #[test]
    fn limit_hours_and_popover_lines() {
        assert_eq!(limit_hours(480), "8 h");
        assert_eq!(limit_hours(450), "7 h 30 min");
        assert_eq!(limit_hours(45), "45 min");
        assert_eq!(limit_lines(None, Lang::En), (None, None));
        let summary: LimitSummary = serde_json::from_value(serde_json::json!({
            "daily": {"scope": "daily", "limit_minutes": 480, "worked_seconds": 18_720, "period": "2026-10-28"},
            "weekly": {"scope": "weekly", "limit_minutes": 2430, "worked_seconds": 111_900, "period": "2026-10-26"}
        }))
        .unwrap();
        assert_eq!(
            limit_lines(Some(&summary), Lang::En),
            (
                Some("5h 12m of 8h today".to_owned()),
                Some("31h 05m of 40h 30m this week".to_owned())
            )
        );
    }

    fn reminder(kind: &str, source: &str, start: Option<&str>, end: &str) -> ReminderPrompt {
        serde_json::from_value(serde_json::json!({
            "id": "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
            "kind": kind, "hours_start": start, "hours_end": end, "source": source
        }))
        .unwrap()
    }

    #[test]
    fn reminder_cards_wording() {
        let now = Utc.with_ymd_and_hms(2026, 10, 28, 9, 10, 0).unwrap();
        let v = reminder_view(
            &reminder(
                "start",
                "mine",
                Some("2026-10-28T09:00:00Z"),
                "2026-10-28T17:30:00Z",
            ),
            now,
            &Utc,
            Lang::En,
        );
        assert_eq!(v.id, "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b");
        assert_eq!(v.title, "Ready to start tracking?");
        assert_eq!(v.detail, "Your hours started at 09:00.");
        assert_eq!(
            (v.primary.label, v.primary.choice),
            ("Start tracking", "start")
        );
        assert_eq!(
            (v.secondary.label, v.secondary.choice),
            ("Not today", "not_today")
        );

        let riga = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        let v = reminder_view(
            &reminder(
                "start",
                "organization",
                Some("2026-10-28T06:30:00Z"),
                "2026-10-28T14:30:00Z",
            ),
            now,
            &riga,
            Lang::En,
        );
        assert_eq!(v.detail, "Your shift started at 08:30.");

        let late = Utc.with_ymd_and_hms(2026, 10, 28, 17, 40, 0).unwrap();
        let v = reminder_view(
            &reminder(
                "stop",
                "mine",
                Some("2026-10-28T09:00:00Z"),
                "2026-10-28T17:30:00Z",
            ),
            late,
            &Utc,
            Lang::En,
        );
        assert_eq!(v.title, "Your hours ended at 17:30");
        assert_eq!(v.detail, "This session is still tracking.");
        assert_eq!(
            (v.primary.label, v.primary.choice),
            ("Stop tracking", "stop")
        );
        assert_eq!(
            (v.secondary.label, v.secondary.choice),
            ("Keep tracking", "keep")
        );

        let v = reminder_view(
            &reminder(
                "still_tracking",
                "organization",
                None,
                "2026-10-28T17:30:00Z",
            ),
            late,
            &Utc,
            Lang::En,
        );
        assert_eq!(v.title, "Still tracking?");
        assert_eq!(v.detail, "Your shift ended at 17:30.");
        // After midnight the date is shown.
        let next = Utc.with_ymd_and_hms(2026, 10, 29, 0, 40, 0).unwrap();
        let v = reminder_view(
            &reminder("still_tracking", "mine", None, "2026-10-28T17:30:00Z"),
            next,
            &Utc,
            Lang::En,
        );
        assert_eq!(v.detail, "Your hours ended at 28 Oct 17:30.");
    }

    #[test]
    fn reminder_notice_is_not_a_banner_and_choices_parse() {
        let notices = vec![(
            4,
            Notice::Reminder {
                id: uuid::Uuid::nil(),
                reminder: ReminderKind::Start,
            },
        )];
        let ctx = BannerContext {
            notices: &notices,
            ..Default::default()
        };
        assert!(banners(Some(&live()), &ctx).is_empty());
        assert_eq!(parse_reminder_choice("start"), Some(ReminderChoice::Start));
        assert_eq!(
            parse_reminder_choice("not_today"),
            Some(ReminderChoice::NotToday)
        );
        assert_eq!(parse_reminder_choice("stop"), Some(ReminderChoice::Stop));
        assert_eq!(parse_reminder_choice("keep"), Some(ReminderChoice::Keep));
        assert_eq!(parse_reminder_choice("snooze"), None);
    }

    #[test]
    fn reminders_section_shows_my_hours_or_the_schedule_note() {
        let mut st = ReminderStatus::default();
        let v = reminders_view(&st, &Utc, Lang::En);
        assert!(v.enabled && v.start && v.stop && v.still_tracking);
        assert_eq!((v.my_start.as_str(), v.my_end.as_str()), ("09:00", "17:30"));
        assert_eq!(v.my_days, [1, 2, 3, 4, 5]);
        assert_eq!(v.schedule_note, None);
        assert_eq!(v.today, "No reminders today");
        st.schedule_sets_hours = true;
        st.window = serde_json::from_value(serde_json::json!({
            "date": "2026-10-28", "start": "2026-10-28T08:00:00Z", "end": "2026-10-28T16:00:00Z",
            "source": "organization"
        }))
        .unwrap();
        let v = reminders_view(&st, &Utc, Lang::En);
        assert_eq!(
            v.schedule_note,
            Some("Your organization's schedule sets these hours")
        );
        assert_eq!(v.today, "Today 08:00–16:00");
    }

    #[test]
    fn reminders_input_is_checked() {
        let ok = RemindersInput {
            enabled: true,
            start: false,
            stop: true,
            still_tracking: true,
            my_start: "08:15".into(),
            my_end: "16:45".into(),
            my_days: vec![5, 1, 2],
        };
        let s = parse_reminders_input(&ok, Lang::En).unwrap();
        assert!(!s.start);
        assert_eq!(s.my_hours.days, [1, 2, 5]);
        assert_eq!(s.my_hours.start.format("%H:%M").to_string(), "08:15");
        let bad = |f: fn(&mut RemindersInput)| {
            let mut i = ok.clone();
            f(&mut i);
            parse_reminders_input(&i, Lang::En).unwrap_err()
        };
        assert_eq!(
            bad(|i| i.my_start = "8".into()),
            "Enter a start time like 09:00."
        );
        assert_eq!(
            bad(|i| i.my_end = "".into()),
            "Enter an end time like 17:30."
        );
        assert_eq!(
            bad(|i| i.my_end = "08:00".into()),
            "The end of your hours must be after the start."
        );
        assert_eq!(bad(|i| i.my_days = vec![8]), "Unknown workday.");
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
