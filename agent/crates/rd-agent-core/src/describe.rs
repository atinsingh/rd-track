//! Plain-language description of an effective policy for the session-start notice.
//!
//! This is a line-for-line port of `describeCollection` in
//! `packages/contracts/src/describe.ts`, which the web "What's collected" page uses, so
//! the agent and the dashboard always say the same thing. Keep the two in sync; the
//! tests below pin the exact strings.

use serde::{Deserialize, Serialize};

use crate::policy::PolicySettings;

/// One line of the "what this session collects" list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionItem {
    /// Stable key (the policy field it describes).
    pub key: String,
    /// Whether this is collected under the policy.
    pub collected: bool,
    /// Short description.
    pub text: String,
    /// Detail line.
    pub detail: String,
}

fn item(key: &str, collected: bool, text: &str, detail: String) -> CollectionItem {
    CollectionItem {
        key: key.to_owned(),
        collected,
        text: text.to_owned(),
        detail,
    }
}

fn off_or(on: bool, detail: &str) -> String {
    if on { detail } else { "Off for you" }.to_owned()
}

/// Describes what is collected under `p` (same order and wording as the web).
pub fn describe_collection(p: &PolicySettings) -> Vec<CollectionItem> {
    let s = &p.screenshots;
    let screenshot_detail = if s.enabled {
        format!(
            "About one every {} minutes, {}, reduced to {} px wide, kept {}{} days",
            s.interval_minutes,
            if s.primary_monitor_only {
                "primary monitor"
            } else {
                "all monitors"
            },
            s.max_width_px,
            if s.excluded_apps.is_empty() {
                ""
            } else {
                "except when excluded apps are in front, "
            },
            p.retention.screenshot_days
        )
    } else {
        "Off for you".to_owned()
    };
    vec![
        item(
            "session",
            true,
            "When your session starts, pauses and stops",
            "Plus the project and task you chose".to_owned(),
        ),
        item(
            "activity",
            true,
            "How many keyboard and mouse events happen each minute",
            "Counts only — never which keys or where you clicked".to_owned(),
        ),
        item(
            "apps.capture_app_name",
            p.apps.capture_app_name,
            "The name of the app in front",
            off_or(
                p.apps.capture_app_name,
                "For example \"Visual Studio Code\"",
            ),
        ),
        item(
            "apps.capture_domains",
            p.apps.capture_domains,
            "Website domains",
            off_or(
                p.apps.capture_domains,
                "Domain only, e.g. \"github.com\" — never full addresses",
            ),
        ),
        item(
            "apps.capture_window_titles",
            p.apps.capture_window_titles,
            "Window titles and full URLs",
            off_or(p.apps.capture_window_titles, "Collected"),
        ),
        item(
            "screenshots.enabled",
            s.enabled,
            "Screenshots",
            screenshot_detail,
        ),
    ]
}

/// What is never collected (same text as the web).
pub const NEVER_COLLECTED: &str = "Which keys you press, typed text, passwords, clipboard, webcam, microphone, the content of messages, email or documents, and your location.";

/// `"6h 42m"` (same as the web's `formatDuration`).
pub fn format_duration(seconds: u64) -> String {
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    format!("{h}h {m:02}m")
}

/// Activity percentage as defined in system design §6.3; `None` when nothing was
/// measurable.
pub fn activity_percent(active_seconds: u64, idle_seconds: u64) -> Option<u8> {
    let measurable = active_seconds + idle_seconds;
    if measurable == 0 {
        return None;
    }
    // Round half up like `Math.round` for non-negative values.
    let pct = (active_seconds * 200 + measurable) / (measurable * 2);
    u8::try_from(pct.min(100)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_web_wording() {
        let items = describe_collection(&PolicySettings::default());
        let keys: Vec<_> = items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "session",
                "activity",
                "apps.capture_app_name",
                "apps.capture_domains",
                "apps.capture_window_titles",
                "screenshots.enabled"
            ]
        );
        assert_eq!(items[0].text, "When your session starts, pauses and stops");
        assert_eq!(items[0].detail, "Plus the project and task you chose");
        assert_eq!(
            items[1].text,
            "How many keyboard and mouse events happen each minute"
        );
        assert_eq!(
            items[1].detail,
            "Counts only — never which keys or where you clicked"
        );
        assert!(items[2].collected);
        assert_eq!(items[2].detail, "For example \"Visual Studio Code\"");
        assert!(!items[3].collected);
        assert_eq!(items[3].detail, "Off for you");
        assert!(!items[4].collected);
        assert!(!items[5].collected);
        assert_eq!(items[5].detail, "Off for you");
    }

    #[test]
    fn screenshot_detail_follows_the_policy() {
        let mut p = PolicySettings::default();
        p.screenshots.enabled = true;
        p.screenshots.interval_minutes = 15;
        p.screenshots.max_width_px = 1280;
        p.retention.screenshot_days = 30;
        let d = &describe_collection(&p)[5];
        assert!(d.collected);
        assert_eq!(
            d.detail,
            "About one every 15 minutes, primary monitor, reduced to 1280 px wide, kept 30 days"
        );
        p.screenshots.primary_monitor_only = false;
        p.screenshots.excluded_apps = vec!["com.example.bank".into()];
        p.apps.capture_app_name = false;
        let items = describe_collection(&p);
        assert_eq!(
            items[5].detail,
            "About one every 15 minutes, all monitors, reduced to 1280 px wide, kept except when excluded apps are in front, 30 days"
        );
        assert!(!items[2].collected);
        assert_eq!(items[2].detail, "Off for you");
    }

    #[test]
    fn duration_and_percent_match_the_web() {
        assert_eq!(format_duration(0), "0h 00m");
        assert_eq!(format_duration(6 * 3600 + 42 * 60 + 59), "6h 42m");
        assert_eq!(activity_percent(0, 0), None);
        assert_eq!(activity_percent(71, 29), Some(71));
        assert_eq!(activity_percent(1, 1), Some(50));
        assert_eq!(activity_percent(1, 2), Some(33));
        assert_eq!(activity_percent(2, 1), Some(67));
        assert_eq!(activity_percent(5, 0), Some(100));
    }
}
