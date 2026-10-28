//! Platform-independent pieces of the native collectors, kept here so they are unit
//! tested on every OS (the FFI modules themselves only build on their target).

use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::PathBuf;

/// A per-second counter delta above this is not real input (the OS counter was reset,
/// e.g. after a logout); the new value itself is then the count since the reset.
pub const MAX_PLAUSIBLE_DELTA: u32 = 1_000_000;

/// Events counted by a free-running `u32` OS counter between two reads, tolerating
/// wraparound at `u32::MAX` and counter resets.
pub fn counter_delta(previous: u32, now: u32) -> u32 {
    let d = now.wrapping_sub(previous);
    if d > MAX_PLAUSIBLE_DELTA {
        now
    } else {
        d
    }
}

/// Milliseconds since the last input from two 32-bit millisecond tick counts
/// (`GetTickCount()` and `LASTINPUTINFO.dwTime`), which wrap every 49.7 days.
pub fn idle_millis(now_tick: u32, last_input_tick: u32) -> u32 {
    now_tick.wrapping_sub(last_input_tick)
}

/// The file name of a path (`C:\Program Files\App\app.exe` → `app.exe`), accepting
/// both separators.
pub fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// The file name without its last extension (`app.exe` → `app`).
pub fn file_stem(path: &str) -> &str {
    let name = file_name(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

/// Decodes a UTF-16 buffer up to (not including) the first NUL.
pub fn utf16_until_nul(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// Converts GDI's BGRA/BGRX pixels to RGBA in place, forcing alpha to opaque (the
/// fourth byte of a screen DIB is undefined).
pub fn bgra_to_rgba(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
}

/// Forces every pixel's alpha to opaque (screens have no transparency; premultiplied
/// bitmap contexts may leave alpha < 255 at the edges).
pub fn force_opaque(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(4) {
        px[3] = 255;
    }
}

/// Seconds of observed input without a single counter increment after which event
/// counters are judged unavailable on this machine.
pub const COUNTER_PROBE_SECONDS: u32 = 30;

/// Decides whether OS event counters work (macOS: `CGEventSourceCounterForEventType`,
/// which may need Input Monitoring on some releases). Counters are trusted once any of
/// them increments; if the idle timer shows input for [`COUNTER_PROBE_SECONDS`] seconds
/// while every counter stays flat, counts are reported unavailable (buckets become
/// `partial` / `permission_missing` instead of silently showing zero activity).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CounterHealth {
    verified: bool,
    flat_input_seconds: u32,
}

impl CounterHealth {
    /// Records one sample: `input_seen` = the idle timer says input happened in it;
    /// `total_counts` = the sum of all counter deltas. Returns whether counts are
    /// currently trustworthy.
    pub fn observe(&mut self, input_seen: bool, total_counts: u64) -> bool {
        if total_counts > 0 {
            self.verified = true;
            self.flat_input_seconds = 0;
        } else if input_seen && !self.verified {
            self.flat_input_seconds = self.flat_input_seconds.saturating_add(1);
        }
        self.available()
    }

    /// Whether counts are currently trustworthy.
    pub fn available(&self) -> bool {
        self.verified || self.flat_input_seconds < COUNTER_PROBE_SECONDS
    }

    /// `true` once counters were seen working.
    pub fn verified(&self) -> bool {
        self.verified
    }

    /// `true` once counters were judged broken.
    pub fn broken(&self) -> bool {
        !self.available()
    }
}

/// Remembers which OS permission prompts were already shown on this install, so a
/// prompt (e.g. macOS `CGRequestScreenCaptureAccess`) is triggered at most once
/// (`DEV-03`). Afterwards the UI only links to System Settings.
#[derive(Debug, Clone)]
pub struct PromptLedger {
    dir: PathBuf,
}

impl PromptLedger {
    /// A ledger stored as marker files in `dir` (the agent's data directory).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn marker(&self, name: &str) -> Option<PathBuf> {
        let ok = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        ok.then(|| self.dir.join(format!("prompted-{name}")))
    }

    /// Whether `name` was already prompted for.
    pub fn was_prompted(&self, name: &str) -> bool {
        self.marker(name).is_some_and(|p| p.exists())
    }

    /// Records the prompt and returns `true` exactly once per install; `false` if it was
    /// already recorded or cannot be recorded (then the caller must not prompt).
    pub fn first_time(&self, name: &str) -> bool {
        let Some(path) = self.marker(name) else {
            return false;
        };
        if std::fs::create_dir_all(&self.dir).is_err() {
            return false;
        }
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(_) => true,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => false,
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_delta_handles_wraparound_and_resets() {
        assert_eq!(counter_delta(10, 15), 5);
        assert_eq!(counter_delta(7, 7), 0);
        assert_eq!(counter_delta(u32::MAX - 2, 4), 7);
        assert_eq!(counter_delta(u32::MAX, 0), 1);
        // Counter reset (now < previous by a lot): count since the reset.
        assert_eq!(counter_delta(50_000, 3), 3);
        assert_eq!(counter_delta(0, MAX_PLAUSIBLE_DELTA), MAX_PLAUSIBLE_DELTA);
        assert_eq!(
            counter_delta(0, MAX_PLAUSIBLE_DELTA + 1),
            MAX_PLAUSIBLE_DELTA + 1
        );
    }

    #[test]
    fn idle_millis_wraps_like_get_tick_count() {
        assert_eq!(idle_millis(5_000, 4_000), 1_000);
        assert_eq!(idle_millis(100, u32::MAX - 899), 1_000);
        assert_eq!(idle_millis(42, 42), 0);
    }

    #[test]
    fn file_names_from_windows_and_unix_paths() {
        let p = r"C:\Program Files\Microsoft VS Code\Code.exe";
        assert_eq!(file_name(p), "Code.exe");
        assert_eq!(file_stem(p), "Code");
        assert_eq!(file_name("/usr/bin/vim"), "vim");
        assert_eq!(file_stem("archive.tar.gz"), "archive.tar");
        assert_eq!(file_stem(".hidden"), ".hidden");
        assert_eq!(file_stem("noext"), "noext");
        assert_eq!(file_name(""), "");
    }

    #[test]
    fn utf16_decoding_stops_at_nul() {
        let mut buf = [0u16; 8];
        for (d, s) in buf.iter_mut().zip("Code".encode_utf16()) {
            *d = s;
        }
        assert_eq!(utf16_until_nul(&buf), "Code");
        let full: Vec<u16> = "Zoom".encode_utf16().collect();
        assert_eq!(utf16_until_nul(&full), "Zoom");
    }

    #[test]
    fn pixel_conversions() {
        let mut px = vec![1, 2, 3, 0, 10, 20, 30, 7];
        bgra_to_rgba(&mut px);
        assert_eq!(px, vec![3, 2, 1, 255, 30, 20, 10, 255]);
        let mut px = vec![1, 2, 3, 0];
        force_opaque(&mut px);
        assert_eq!(px, vec![1, 2, 3, 255]);
    }

    #[test]
    fn counter_health_trusts_working_counters_and_flags_flat_ones() {
        let mut h = CounterHealth::default();
        for _ in 0..COUNTER_PROBE_SECONDS - 1 {
            assert!(h.observe(true, 0));
        }
        // Idle seconds without input never count against the counters.
        for _ in 0..1000 {
            assert!(h.observe(false, 0));
        }
        assert!(!h.observe(true, 0), "flat for the whole probe window");
        assert!(h.broken());
        // A later increment proves they work after all.
        assert!(h.observe(true, 3));
        assert!(h.verified());
        for _ in 0..1000 {
            assert!(h.observe(true, 0), "verified counters stay trusted");
        }
    }

    #[test]
    fn prompt_ledger_allows_each_prompt_once() {
        let dir = tempfile::tempdir().unwrap();
        let l = PromptLedger::new(dir.path().join("data"));
        assert!(!l.was_prompted("screen_recording"));
        assert!(l.first_time("screen_recording"));
        assert!(!l.first_time("screen_recording"));
        assert!(l.was_prompted("screen_recording"));
        assert!(PromptLedger::new(dir.path().join("data")).was_prompted("screen_recording"));
        assert!(l.first_time("input_monitoring"));
        assert!(!l.first_time("../escape"));
        assert!(!l.first_time(""));
    }
}
