//! Signing in to connect this computer: at most one sign-in waits for the browser at a
//! time. Each start (and each cancel) moves a generation counter on, so a poller that
//! belongs to an older generation stops at its next pause and its answer is ignored.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rd_agent::setup::LinkStart;
use serde::Serialize;

/// What the popover shows while waiting for the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignInView {
    /// The code the browser shows too, to check they match.
    pub user_code: String,
    /// Where the person signs in ("Open the browser again").
    pub approve_url: String,
    /// When the request lapses (RFC 3339).
    pub expires_at: String,
}

/// The sign-in in progress, if any.
#[derive(Default)]
pub struct SignInSlot {
    generation: AtomicU64,
    current: Mutex<Option<(u64, LinkStart)>>,
}

/// How long one slice of a poller's pause is, so a cancel takes effect promptly.
const SLICE: Duration = Duration::from_millis(200);

impl SignInSlot {
    fn current(&self) -> std::sync::MutexGuard<'_, Option<(u64, LinkStart)>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts waiting for `start`, replacing any sign-in already waiting. Returns the
    /// generation its poller belongs to.
    pub fn begin(&self, start: LinkStart) -> u64 {
        let mut c = self.current();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *c = Some((generation, start));
        generation
    }

    /// Stops waiting (the poller stops at its next pause). Returns whether one was waiting.
    pub fn cancel(&self) -> bool {
        let mut c = self.current();
        self.generation.fetch_add(1, Ordering::SeqCst);
        c.take().is_some()
    }

    /// Whether the poller of `generation` should carry on.
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// Ends the sign-in of `generation` when it is still the current one; `false` when it
    /// was cancelled or replaced meanwhile (its answer must then be ignored).
    pub fn end(&self, generation: u64) -> bool {
        let mut c = self.current();
        let mine = c.as_ref().is_some_and(|(g, _)| *g == generation) && self.is_current(generation);
        if mine {
            *c = None;
        }
        mine
    }

    /// Pauses a poller for `d`, waking early when its sign-in is cancelled or replaced.
    /// Returns whether it should carry on.
    pub fn pause(&self, generation: u64, d: Duration) -> bool {
        let until = Instant::now() + d;
        while self.is_current(generation) {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            std::thread::sleep(left.min(SLICE));
        }
        false
    }

    /// The popover's view of the sign-in waiting, if any.
    pub fn view(&self) -> Option<SignInView> {
        self.current().as_ref().map(|(_, s)| SignInView {
            user_code: s.user_code.clone(),
            approve_url: s.approve_url.clone(),
            expires_at: s
                .expires_at
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        })
    }

    /// The page to open again, if a sign-in is waiting.
    pub fn approve_url(&self) -> Option<String> {
        self.current().as_ref().map(|(_, s)| s.approve_url.clone())
    }
}

/// Only web pages are opened from what the server answered.
pub fn openable(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::sync::Arc;

    fn start(code: &str) -> LinkStart {
        LinkStart {
            server: "https://x.test".into(),
            device_name: "laptop".into(),
            request_id: "r1".into(),
            user_code: code.into(),
            poll_secret: "secret".into(),
            approve_url: "https://x.test/connect?request=r1".into(),
            expires_at: Utc.with_ymd_and_hms(2026, 10, 31, 10, 10, 0).unwrap(),
            interval: Duration::from_secs(5),
        }
    }

    #[test]
    fn one_sign_in_at_a_time() {
        let slot = SignInSlot::default();
        assert_eq!(slot.view(), None);
        let first = slot.begin(start("AAAA-1111"));
        assert!(slot.is_current(first));
        // Starting again replaces it: the first poller's answer no longer counts.
        let second = slot.begin(start("BBBB-2222"));
        assert!(!slot.is_current(first));
        assert!(!slot.end(first));
        assert_eq!(slot.view().unwrap().user_code, "BBBB-2222");
        // The current one ends once.
        assert!(slot.end(second));
        assert!(!slot.end(second));
        assert_eq!(slot.view(), None);
        assert_eq!(slot.approve_url(), None);
    }

    #[test]
    fn cancelling_stops_the_poller_and_drops_its_answer() {
        let slot = Arc::new(SignInSlot::default());
        let g = slot.begin(start("AAAA-1111"));
        assert_eq!(
            slot.approve_url().as_deref(),
            Some("https://x.test/connect?request=r1")
        );
        let s = slot.clone();
        let t0 = Instant::now();
        let poller = std::thread::spawn(move || s.pause(g, Duration::from_secs(30)));
        std::thread::sleep(Duration::from_millis(50));
        assert!(slot.cancel());
        assert!(!poller.join().unwrap(), "the pause ends as cancelled");
        assert!(t0.elapsed() < Duration::from_secs(2), "promptly");
        assert!(!slot.end(g));
        assert_eq!(slot.view(), None);
        assert!(!slot.cancel(), "nothing left to cancel");
        // A short pause of a current sign-in runs to the end.
        let g = slot.begin(start("CCCC-3333"));
        assert!(slot.pause(g, Duration::from_millis(10)));
    }

    #[test]
    fn the_view_serializes_for_the_popover() {
        let slot = SignInSlot::default();
        slot.begin(start("ABCD-2345"));
        assert_eq!(
            serde_json::to_value(slot.view()).unwrap(),
            serde_json::json!({
                "user_code": "ABCD-2345",
                "approve_url": "https://x.test/connect?request=r1",
                "expires_at": "2026-10-31T10:10:00Z",
            })
        );
    }

    #[test]
    fn only_web_pages_open() {
        assert!(openable("https://track.example.com/connect?request=1"));
        assert!(openable("http://localhost:3000/connect"));
        assert!(!openable("http://track.example.com/connect"));
        assert!(!openable("file:///etc/passwd"));
        assert!(!openable("rdtrack://enroll"));
    }
}
