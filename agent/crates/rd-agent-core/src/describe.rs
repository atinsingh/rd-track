//! Plain-language description of an effective policy for the session-start notice.
//!
//! This is a line-for-line port of `describeCollection` in
//! `packages/contracts/src/describe.ts`, which the web "What's collected" page uses, so
//! the agent and the dashboard always say the same thing. Keep the two in sync; the
//! tests below pin the exact strings.

use serde::{Deserialize, Serialize};

use crate::i18n::{fill, Lang, Messages, EN};
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

fn off_or(m: &Messages, on: bool, detail: &str) -> String {
    if on { detail } else { m.collect_off }.to_owned()
}

/// Describes what is collected under `p` (same order and wording as the web), in English.
pub fn describe_collection(p: &PolicySettings) -> Vec<CollectionItem> {
    describe_collection_in(p, Lang::En)
}

/// Describes what is collected under `p` in `lang` (the English is the web's, word for word).
pub fn describe_collection_in(p: &PolicySettings, lang: Lang) -> Vec<CollectionItem> {
    let m = lang.messages();
    let s = &p.screenshots;
    let screenshot_detail = if s.enabled {
        fill(
            m.collect_shots_detail,
            &[
                ("minutes", &s.interval_minutes.to_string()),
                (
                    "monitors",
                    if s.primary_monitor_only {
                        m.collect_shots_primary
                    } else {
                        m.collect_shots_all
                    },
                ),
                ("width", &s.max_width_px.to_string()),
                (
                    "excluded",
                    if s.excluded_apps.is_empty() {
                        ""
                    } else {
                        m.collect_shots_excluded
                    },
                ),
                ("days", &p.retention.screenshot_days.to_string()),
            ],
        )
    } else {
        m.collect_off.to_owned()
    };
    vec![
        item(
            "session",
            true,
            m.collect_session_text,
            m.collect_session_detail.to_owned(),
        ),
        item(
            "activity",
            true,
            m.collect_activity_text,
            m.collect_activity_detail.to_owned(),
        ),
        item(
            "apps.capture_app_name",
            p.apps.capture_app_name,
            m.collect_app_text,
            off_or(m, p.apps.capture_app_name, m.collect_app_detail),
        ),
        item(
            "apps.capture_domains",
            p.apps.capture_domains,
            m.collect_domains_text,
            off_or(m, p.apps.capture_domains, m.collect_domains_detail),
        ),
        item(
            "apps.capture_window_titles",
            p.apps.capture_window_titles,
            m.collect_titles_text,
            off_or(m, p.apps.capture_window_titles, m.collect_titles_detail),
        ),
        item(
            "screenshots.enabled",
            s.enabled,
            m.collect_shots_text,
            screenshot_detail,
        ),
    ]
}

/// What is never collected (same text as the web), in English.
pub const NEVER_COLLECTED: &str = EN.never_collected;

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
