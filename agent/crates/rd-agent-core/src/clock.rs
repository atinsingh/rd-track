//! Wall and monotonic clocks, and the per-tick discontinuity detector.
//!
//! Durations in the agent always come from the **monotonic** clock (§7 of the system
//! design). The monotonic clock used here *includes* time spent suspended
//! (`CLOCK_BOOTTIME` on Linux, `CLOCK_MONOTONIC` on macOS, `QueryPerformanceCounter` via
//! `Instant` on Windows), which is what lets [`TickObserver`] tell the two kinds of
//! wall-clock jumps apart:
//!
//! * wall **and** monotonic both jumped → the machine was asleep → [`TickKind::Suspended`];
//! * wall jumped, monotonic did not → someone changed the clock → [`TickKind::ClockChange`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};

/// Source of time for the agent. Injectable so tests can drive time explicitly.
pub trait Clock: Send + Sync {
    /// Current wall-clock time (UTC).
    fn wall(&self) -> DateTime<Utc>;
    /// Monotonic time since an arbitrary origin, including time spent suspended.
    fn monotonic(&self) -> Duration;
}

/// The real system clock.
#[derive(Debug)]
pub struct SystemClock {
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    origin: std::time::Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemClock {
    /// Creates a system clock.
    pub fn new() -> Self {
        Self {
            #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
            origin: std::time::Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn wall(&self) -> DateTime<Utc> {
        Utc::now()
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    fn monotonic(&self) -> Duration {
        sys::monotonic_including_suspend()
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    fn monotonic(&self) -> Duration {
        // On Windows `Instant` is QueryPerformanceCounter, which keeps counting in sleep.
        self.origin.elapsed()
    }
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
#[allow(unsafe_code)]
mod sys {
    use std::time::Duration;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const CLOCK: libc::clockid_t = libc::CLOCK_BOOTTIME;
    #[cfg(target_os = "macos")]
    const CLOCK: libc::clockid_t = libc::CLOCK_MONOTONIC;

    pub(super) fn monotonic_including_suspend() -> Duration {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid, writable timespec and CLOCK is a supported clock id.
        let rc = unsafe { libc::clock_gettime(CLOCK, &mut ts) };
        if rc != 0 {
            return Duration::ZERO;
        }
        Duration::new(
            u64::try_from(ts.tv_sec).unwrap_or(0),
            u32::try_from(ts.tv_nsec).unwrap_or(0),
        )
    }
}

/// A manually driven clock for tests and simulations. Cloning shares the same time.
#[derive(Debug, Clone)]
pub struct FakeClock {
    inner: Arc<Mutex<(DateTime<Utc>, Duration)>>,
}

impl FakeClock {
    /// Creates a fake clock at the given wall time with monotonic time zero.
    pub fn new(wall: DateTime<Utc>) -> Self {
        Self {
            inner: Arc::new(Mutex::new((wall, Duration::ZERO))),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut (DateTime<Utc>, Duration)) -> R) -> R {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g)
    }

    /// Advances wall and monotonic time together (normal passage of time, or sleep).
    pub fn advance(&self, d: Duration) {
        self.with(|(w, m)| {
            *w += TimeDelta::from_std(d).unwrap_or(TimeDelta::zero());
            *m += d;
        });
    }

    /// Moves only the wall clock (a user or NTP changing the time).
    pub fn jump_wall(&self, delta: TimeDelta) {
        self.with(|(w, _)| *w += delta);
    }
}

impl Clock for FakeClock {
    fn wall(&self) -> DateTime<Utc> {
        self.with(|(w, _)| *w)
    }
    fn monotonic(&self) -> Duration {
        self.with(|(_, m)| *m)
    }
}

/// One reading of both clocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockReading {
    /// Wall-clock time.
    pub wall: DateTime<Utc>,
    /// Monotonic time.
    pub mono: Duration,
}

impl ClockReading {
    /// Reads both clocks.
    pub fn now(clock: &dyn Clock) -> Self {
        Self {
            wall: clock.wall(),
            mono: clock.monotonic(),
        }
    }
}

/// Classification of the time elapsed since the previous tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickKind {
    /// First tick after (re)starting observation.
    First,
    /// Ordinary tick; `elapsed` is the monotonic time since the previous tick.
    Normal {
        /// Monotonic time since the previous tick.
        elapsed: Duration,
    },
    /// The machine was asleep between `gap_start` and `gap_end`.
    Suspended {
        /// Wall time of the last tick before the sleep.
        gap_start: DateTime<Utc>,
        /// Wall time of the first tick after waking.
        gap_end: DateTime<Utc>,
    },
    /// The wall clock was changed without monotonic time passing.
    ClockChange {
        /// The earlier of the two wall readings.
        gap_start: DateTime<Utc>,
        /// The later of the two wall readings.
        gap_end: DateTime<Utc>,
        /// Monotonic time since the previous tick (still real elapsed time).
        elapsed: Duration,
        /// `true` when the wall clock moved backwards.
        backwards: bool,
    },
}

/// Compares consecutive clock readings and classifies each tick.
#[derive(Debug, Clone)]
pub struct TickObserver {
    tick: Duration,
    prev: Option<ClockReading>,
}

impl TickObserver {
    /// Creates an observer for a loop with the given nominal tick length.
    pub fn new(tick: Duration) -> Self {
        Self { tick, prev: None }
    }

    /// Forgets the previous reading; the next observation is [`TickKind::First`].
    pub fn reset(&mut self) {
        self.prev = None;
    }

    /// The previous reading, if any.
    pub fn previous(&self) -> Option<ClockReading> {
        self.prev
    }

    /// Classifies `now` relative to the previous reading and remembers it.
    pub fn observe(&mut self, now: ClockReading) -> TickKind {
        let Some(prev) = self.prev.replace(now) else {
            return TickKind::First;
        };
        let threshold = self.tick * 2;
        let mono = now.mono.saturating_sub(prev.mono);
        let wall_ms = (now.wall - prev.wall).num_milliseconds();
        let mono_ms = i64::try_from(mono.as_millis()).unwrap_or(i64::MAX);
        let threshold_ms = i64::try_from(threshold.as_millis()).unwrap_or(i64::MAX);

        if mono > threshold {
            let (gap_start, gap_end) = ordered(prev.wall, now.wall);
            return TickKind::Suspended { gap_start, gap_end };
        }
        if (wall_ms - mono_ms).abs() > threshold_ms {
            let (gap_start, gap_end) = ordered(prev.wall, now.wall);
            return TickKind::ClockChange {
                gap_start,
                gap_end,
                elapsed: mono,
                backwards: wall_ms < 0,
            };
        }
        TickKind::Normal { elapsed: mono }
    }
}

fn ordered(a: DateTime<Utc>, b: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap()
    }

    #[test]
    fn system_clock_is_monotonic() {
        let c = SystemClock::new();
        let a = c.monotonic();
        let b = c.monotonic();
        assert!(b >= a);
    }

    #[test]
    fn classifies_normal_suspend_and_clock_change() {
        let clock = FakeClock::new(t0());
        let mut obs = TickObserver::new(Duration::from_secs(1));
        assert_eq!(obs.observe(ClockReading::now(&clock)), TickKind::First);

        clock.advance(Duration::from_millis(1500));
        assert_eq!(
            obs.observe(ClockReading::now(&clock)),
            TickKind::Normal {
                elapsed: Duration::from_millis(1500)
            }
        );

        let before = clock.wall();
        clock.advance(Duration::from_secs(7200));
        assert_eq!(
            obs.observe(ClockReading::now(&clock)),
            TickKind::Suspended {
                gap_start: before,
                gap_end: before + TimeDelta::hours(2)
            }
        );

        let before = clock.wall();
        clock.advance(Duration::from_secs(1));
        clock.jump_wall(TimeDelta::minutes(-10));
        match obs.observe(ClockReading::now(&clock)) {
            TickKind::ClockChange {
                gap_start,
                gap_end,
                backwards,
                elapsed,
            } => {
                assert!(backwards);
                assert_eq!(gap_end, before);
                assert_eq!(
                    gap_start,
                    before - TimeDelta::minutes(10) + TimeDelta::seconds(1)
                );
                assert_eq!(elapsed, Duration::from_secs(1));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn exactly_two_ticks_is_still_normal() {
        let clock = FakeClock::new(t0());
        let mut obs = TickObserver::new(Duration::from_secs(1));
        obs.observe(ClockReading::now(&clock));
        clock.advance(Duration::from_secs(2));
        assert!(matches!(
            obs.observe(ClockReading::now(&clock)),
            TickKind::Normal { .. }
        ));
    }
}
