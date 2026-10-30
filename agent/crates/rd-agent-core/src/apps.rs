//! Foreground application tracking → `app_usage.v1` segments.
//!
//! Each tick's monotonic elapsed time is credited to the application in the foreground
//! at the end of that tick. A segment is flushed when the application changes, when the
//! foreground becomes empty, when capture is interrupted, and at the latest every
//! [`MAX_SEGMENT_SECONDS`], so `duration_seconds` is always within `1..=3600`.
//!
//! Only the application identifier and name are seen here, and for a browser (Pro, when
//! the policy asks for it) the active tab's hostname; a change of domain starts a new
//! segment. Never window titles, document names, paths or full URLs.

use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};

use crate::events::AppUsage;
use crate::platform::ForegroundAppInfo;

/// Segments are flushed at least this often (5 minutes).
pub const MAX_SEGMENT_SECONDS: u32 = 300;
/// Maximum length kept for identifiers and names.
pub const MAX_NAME_CHARS: usize = 255;

#[derive(Debug, Clone)]
struct Segment {
    app: ForegroundAppInfo,
    domain: Option<String>,
    started_at: DateTime<Utc>,
    seconds: u32,
}

/// Builds app-usage segments from foreground samples.
#[derive(Debug, Clone, Default)]
pub struct AppTracker {
    current: Option<Segment>,
    carry_ms: u128,
}

/// Normalises an identifier or name: strips control characters, trims, truncates.
pub fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_NAME_CHARS)
        .collect()
}

impl AppTracker {
    /// A tracker with no open segment.
    pub fn new() -> Self {
        Self::default()
    }

    /// Credits `elapsed` (ending at wall time `at`) to `app`. Returns finished segments.
    pub fn record(
        &mut self,
        at: DateTime<Utc>,
        elapsed: Duration,
        app: Option<ForegroundAppInfo>,
    ) -> Vec<AppUsage> {
        self.record_with_domain(at, elapsed, app, None)
    }

    /// Like [`AppTracker::record`], with the browser tab's domain (already normalised).
    pub fn record_with_domain(
        &mut self,
        at: DateTime<Utc>,
        elapsed: Duration,
        app: Option<ForegroundAppInfo>,
        domain: Option<String>,
    ) -> Vec<AppUsage> {
        let mut out = Vec::new();
        let app = app
            .map(|a| {
                let app_identifier = sanitize(&a.app_identifier);
                let name = sanitize(&a.app_name);
                ForegroundAppInfo {
                    // `app_name` must be non-empty on the wire; fall back to the identifier.
                    app_name: if name.is_empty() {
                        app_identifier.clone()
                    } else {
                        name
                    },
                    app_identifier,
                }
            })
            .filter(|a| !a.app_identifier.is_empty());

        let total_ms = self.carry_ms + elapsed.as_millis();
        let secs = u32::try_from(total_ms / 1000).unwrap_or(u32::MAX);
        self.carry_ms = total_ms % 1000;

        let Some(app) = app else {
            out.extend(self.flush());
            return out;
        };
        if self
            .current
            .as_ref()
            .is_some_and(|s| s.app != app || s.domain != domain)
        {
            out.extend(self.take_segment());
        }
        let seg = self.current.get_or_insert_with(|| Segment {
            started_at: at - TimeDelta::from_std(elapsed).unwrap_or(TimeDelta::zero()),
            app,
            domain,
            seconds: 0,
        });
        seg.seconds = seg.seconds.saturating_add(secs);
        if seg.seconds >= MAX_SEGMENT_SECONDS {
            let next_start = seg.started_at + TimeDelta::seconds(i64::from(seg.seconds));
            let app = seg.app.clone();
            let domain = seg.domain.clone();
            out.extend(self.take_segment());
            self.current = Some(Segment {
                app,
                domain,
                started_at: next_start,
                seconds: 0,
            });
        }
        out
    }

    /// Closes the open segment (pause, stop, suspend) and resets sub-second carry.
    pub fn flush(&mut self) -> Vec<AppUsage> {
        self.carry_ms = 0;
        self.take_segment().into_iter().collect()
    }

    fn take_segment(&mut self) -> Option<AppUsage> {
        let seg = self.current.take()?;
        if seg.seconds == 0 {
            return None;
        }
        Some(AppUsage {
            app_identifier: seg.app.app_identifier,
            app_name: seg.app.app_name,
            domain: seg.domain,
            started_at: seg.started_at,
            duration_seconds: seg.seconds.min(3600),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn app(id: &str) -> Option<ForegroundAppInfo> {
        Some(ForegroundAppInfo {
            app_identifier: id.into(),
            app_name: id.to_uppercase(),
        })
    }

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap()
    }

    fn run(tr: &mut AppTracker, start: DateTime<Utc>, secs: u32, a: &str) -> Vec<AppUsage> {
        (1..=secs)
            .flat_map(|i| {
                tr.record(
                    start + TimeDelta::seconds(i64::from(i)),
                    Duration::from_secs(1),
                    app(a),
                )
            })
            .collect()
    }

    #[test]
    fn flushes_on_app_change() {
        let mut tr = AppTracker::new();
        assert!(run(&mut tr, t0(), 42, "editor").is_empty());
        let out = run(&mut tr, t0() + TimeDelta::seconds(42), 10, "browser");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].app_identifier, "editor");
        assert_eq!(out[0].app_name, "EDITOR");
        assert_eq!(out[0].started_at, t0());
        assert_eq!(out[0].duration_seconds, 42);
        let out = tr.flush();
        assert_eq!(out[0].app_identifier, "browser");
        assert_eq!(out[0].started_at, t0() + TimeDelta::seconds(42));
        assert_eq!(out[0].duration_seconds, 10);
        assert!(tr.flush().is_empty());
    }

    #[test]
    fn flushes_every_five_minutes_with_contiguous_segments() {
        let mut tr = AppTracker::new();
        let out = run(&mut tr, t0(), 750, "editor");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].duration_seconds, 300);
        assert_eq!(out[1].started_at, t0() + TimeDelta::seconds(300));
        assert_eq!(out[1].duration_seconds, 300);
        let rest = tr.flush();
        assert_eq!(rest[0].started_at, t0() + TimeDelta::seconds(600));
        assert_eq!(rest[0].duration_seconds, 150);
        for seg in out.iter().chain(&rest) {
            assert!((1..=3600).contains(&seg.duration_seconds));
        }
    }

    #[test]
    fn empty_foreground_closes_segment_and_zero_length_is_dropped() {
        let mut tr = AppTracker::new();
        run(&mut tr, t0(), 5, "editor");
        let out = tr.record(t0() + TimeDelta::seconds(6), Duration::from_secs(1), None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].duration_seconds, 5);
        // Sub-second tick only: no segment of zero length is ever emitted.
        tr.record(t0(), Duration::from_millis(400), app("x"));
        assert!(tr.flush().is_empty());
    }

    #[test]
    fn a_new_domain_starts_a_new_segment() {
        let mut tr = AppTracker::new();
        let at = |s: i64| t0() + TimeDelta::seconds(s);
        let sec = Duration::from_secs(1);
        let d = |s: &str| Some(s.to_owned());
        assert!(tr
            .record_with_domain(at(1), sec * 20, app("chrome"), d("github.com"))
            .is_empty());
        let out = tr.record_with_domain(at(31), sec * 10, app("chrome"), d("docs.rs"));
        assert_eq!(out.len(), 1);
        assert_eq!(
            (out[0].domain.as_deref(), out[0].duration_seconds),
            (Some("github.com"), 20)
        );
        let out = tr.record_with_domain(at(36), sec * 5, app("chrome"), None);
        assert_eq!(
            (out[0].domain.as_deref(), out[0].duration_seconds),
            (Some("docs.rs"), 10)
        );
        assert_eq!(tr.flush()[0].domain, None);
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize("  Edit\u{0}or\n "), "Editor");
        assert_eq!(sanitize(&"a".repeat(1000)).len(), MAX_NAME_CHARS);
        let mut tr = AppTracker::new();
        let out = tr.record(
            t0(),
            Duration::from_secs(3),
            Some(ForegroundAppInfo {
                app_identifier: " \n".into(),
                app_name: "ghost".into(),
            }),
        );
        assert!(out.is_empty());
        assert!(tr.flush().is_empty());

        tr.record(
            t0(),
            Duration::from_secs(2),
            Some(ForegroundAppInfo {
                app_identifier: "svc.exe".into(),
                app_name: "\u{7}".into(),
            }),
        );
        assert_eq!(tr.flush()[0].app_name, "svc.exe");
    }
}
