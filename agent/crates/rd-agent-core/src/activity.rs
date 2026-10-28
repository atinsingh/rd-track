//! Activity aggregation (system design §6.3).
//!
//! Each tick delivers one [`InputSample`] (counts since the previous tick plus the
//! OS-reported time since the last input) and the **monotonic** time that elapsed. The
//! aggregator turns elapsed time into whole seconds (carrying the remainder), classifies
//! every second, and folds seconds into buckets aligned to UTC minutes.
//!
//! Classification of a second:
//!
//! * **active** — input occurred during it, or it is part of an inactive run that ended
//!   (with new input or with the session being interrupted) before the idle threshold;
//! * **idle** — part of an inactive run that reached the threshold. The whole run is
//!   idle, attributed back to its first second, so a 5-minute threshold does not hide
//!   5 minutes of idleness;
//! * **pending** — inactive, threshold not reached yet. Buckets containing pending
//!   seconds are held back until the run resolves (at most `threshold` seconds).
//! * **missing** — no input data at all (permission missing). Counted in neither.
//!
//! Buckets are emitted once their minute is over and they hold no pending seconds. A
//! bucket is never emitted twice: seconds that would land in an already-emitted minute
//! (after a backwards clock change) are dropped.

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};

use crate::events::{ActivityBucket, DataQuality};
use crate::platform::InputSample;
use crate::ts::floor_minute;

/// Seconds in a bucket.
pub const BUCKET_SECONDS: u32 = 60;

#[derive(Debug, Default, Clone)]
struct Acc {
    active: u32,
    idle: u32,
    pending: u32,
    missing: u32,
    degraded: u32,
    keyboard: u64,
    mouse: u64,
}

impl Acc {
    fn total(&self) -> u32 {
        self.active + self.idle + self.pending + self.missing
    }

    fn to_bucket(&self, start: DateTime<Utc>) -> ActivityBucket {
        let total = self.total();
        let data_quality = if total > 0 && self.missing == total {
            DataQuality::PermissionMissing
        } else if self.missing > 0 || self.degraded > 0 {
            DataQuality::Partial
        } else {
            DataQuality::Ok
        };
        ActivityBucket {
            bucket_start: start,
            active_seconds: self.active,
            idle_seconds: self.idle,
            keyboard_count: self.keyboard,
            mouse_count: self.mouse,
            data_quality,
        }
    }
}

/// Folds per-tick input samples into minute buckets for one session.
#[derive(Debug, Clone)]
pub struct ActivityAggregator {
    threshold_secs: u32,
    open: BTreeMap<DateTime<Utc>, Acc>,
    /// Pending seconds per minute, oldest first (the current inactive run).
    pending: BTreeMap<DateTime<Utc>, u32>,
    idle_mode: bool,
    own_idle_secs: u32,
    carry_ms: u128,
    carry_keyboard: u64,
    carry_mouse: u64,
    carry_input: bool,
    last_emitted: Option<DateTime<Utc>>,
    dropped_seconds: u64,
}

impl ActivityAggregator {
    /// Creates an aggregator with the given idle threshold (seconds, clamped to ≥ 1).
    pub fn new(threshold_secs: u32) -> Self {
        Self {
            threshold_secs: threshold_secs.max(1),
            open: BTreeMap::new(),
            pending: BTreeMap::new(),
            idle_mode: false,
            own_idle_secs: 0,
            carry_ms: 0,
            carry_keyboard: 0,
            carry_mouse: 0,
            carry_input: false,
            last_emitted: None,
            dropped_seconds: 0,
        }
    }

    /// Changes the idle threshold (applies from the next second).
    pub fn set_threshold(&mut self, threshold_secs: u32) {
        self.threshold_secs = threshold_secs.max(1);
    }

    /// Seconds discarded because they would have landed in an already-emitted minute.
    pub fn dropped_seconds(&self) -> u64 {
        self.dropped_seconds
    }

    /// `true` when no bucket is open.
    pub fn is_empty(&self) -> bool {
        self.open.is_empty()
    }

    /// Records one tick ending at wall time `at`, covering `elapsed` monotonic time.
    /// Returns the buckets that became complete.
    pub fn record(
        &mut self,
        at: DateTime<Utc>,
        elapsed: Duration,
        sample: InputSample,
    ) -> Vec<ActivityBucket> {
        let total_ms = self.carry_ms + elapsed.as_millis();
        let n = u32::try_from(total_ms / 1000).unwrap_or(u32::MAX).min(3600);
        self.carry_ms = total_ms % 1000;

        let has_counts = sample.counts_available;
        let has_since = sample.seconds_since_last_input.is_some();
        let elapsed_secs = elapsed.as_secs_f64().max(1.0);
        let tick_input = (has_counts && (sample.keyboard_count > 0 || sample.mouse_count > 0))
            || sample
                .seconds_since_last_input
                .is_some_and(|s| s < elapsed_secs);
        if has_counts {
            self.carry_keyboard += u64::from(sample.keyboard_count);
            self.carry_mouse += u64::from(sample.mouse_count);
        }
        self.carry_input |= tick_input;

        if n == 0 {
            return self.emit_completed(at);
        }

        let had_input = std::mem::take(&mut self.carry_input);
        let mut last_minute = None;
        for i in 0..n {
            let ts = at - TimeDelta::seconds(i64::from(n - 1 - i));
            let minute = floor_minute(ts);
            if !self.ensure_open(minute) {
                self.dropped_seconds += 1;
                continue;
            }
            last_minute = Some(minute);
            if !has_counts && !has_since {
                self.add(minute, |a| a.missing += 1);
                continue;
            }
            if !has_counts {
                self.add(minute, |a| a.degraded += 1);
            }
            if had_input {
                self.resolve_pending(true);
                self.idle_mode = false;
                self.own_idle_secs = 0;
                self.add(minute, |a| a.active += 1);
                continue;
            }
            self.own_idle_secs = self.own_idle_secs.saturating_add(1);
            if self.idle_mode {
                self.add(minute, |a| a.idle += 1);
                continue;
            }
            self.add(minute, |a| a.pending += 1);
            *self.pending.entry(minute).or_insert(0) += 1;
            let idle_for = sample
                .seconds_since_last_input
                .unwrap_or(f64::from(self.own_idle_secs));
            if idle_for >= f64::from(self.threshold_secs)
                || self.own_idle_secs >= self.threshold_secs
            {
                self.resolve_pending(false);
                self.idle_mode = true;
            }
        }
        if let Some(minute) = last_minute {
            let (kb, ms) = (
                std::mem::take(&mut self.carry_keyboard),
                std::mem::take(&mut self.carry_mouse),
            );
            self.add(minute, |a| {
                a.keyboard += kb;
                a.mouse += ms;
            });
        }
        self.emit_completed(at)
    }

    /// Emits buckets whose minute ended before `now` and that hold no pending seconds.
    /// Called on every tick, including while paused (to release a parked bucket).
    pub fn emit_completed(&mut self, now: DateTime<Utc>) -> Vec<ActivityBucket> {
        let mut limit = floor_minute(now);
        if let Some((&oldest_pending, _)) = self.pending.iter().next() {
            limit = limit.min(oldest_pending);
        }
        self.emit_before(limit)
    }

    /// The capture was interrupted (pause, suspend, clock change): the inactive run ends
    /// (its pending seconds become active, as the threshold was not reached), the
    /// sub-second remainder is discarded, and every bucket of a minute before `now` is
    /// emitted. The bucket of the current minute stays open so a resume within the same
    /// minute continues it instead of emitting a second bucket with the same start.
    pub fn interrupt(&mut self, now: DateTime<Utc>) -> Vec<ActivityBucket> {
        self.resolve_pending(true);
        self.reset_run();
        self.emit_before(floor_minute(now))
    }

    /// Ends the session: resolves pending seconds as active and emits every open bucket.
    pub fn flush_all(&mut self) -> Vec<ActivityBucket> {
        self.resolve_pending(true);
        self.reset_run();
        let out: Vec<_> = std::mem::take(&mut self.open)
            .into_iter()
            .map(|(m, a)| a.to_bucket(m))
            .collect();
        if let Some(b) = out.last() {
            self.last_emitted = Some(b.bucket_start);
        }
        out
    }

    fn reset_run(&mut self) {
        self.idle_mode = false;
        self.own_idle_secs = 0;
        self.carry_ms = 0;
        self.carry_input = false;
        self.carry_keyboard = 0;
        self.carry_mouse = 0;
    }

    fn emit_before(&mut self, limit: DateTime<Utc>) -> Vec<ActivityBucket> {
        let keep = self.open.split_off(&limit);
        let done = std::mem::replace(&mut self.open, keep);
        let out: Vec<_> = done.into_iter().map(|(m, a)| a.to_bucket(m)).collect();
        if let Some(b) = out.last() {
            if self.last_emitted.is_none_or(|l| b.bucket_start > l) {
                self.last_emitted = Some(b.bucket_start);
            }
        }
        out
    }

    /// Opens the bucket for `minute` if allowed; `false` if it would duplicate an
    /// emitted bucket or the bucket is already full.
    fn ensure_open(&mut self, minute: DateTime<Utc>) -> bool {
        if let Some(acc) = self.open.get(&minute) {
            return acc.total() < BUCKET_SECONDS;
        }
        if self.last_emitted.is_some_and(|l| minute <= l) {
            return false;
        }
        self.open.insert(minute, Acc::default());
        true
    }

    fn add(&mut self, minute: DateTime<Utc>, f: impl FnOnce(&mut Acc)) {
        if let Some(acc) = self.open.get_mut(&minute) {
            f(acc);
        }
    }

    fn resolve_pending(&mut self, as_active: bool) {
        for (minute, n) in std::mem::take(&mut self.pending) {
            if let Some(acc) = self.open.get_mut(&minute) {
                let n = n.min(acc.pending);
                acc.pending -= n;
                if as_active {
                    acc.active += n;
                } else {
                    acc.idle += n;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    const SEC: Duration = Duration::from_secs(1);

    fn t(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, h, m, s).unwrap()
    }

    fn input(n: u32) -> InputSample {
        InputSample {
            keyboard_count: n,
            mouse_count: n,
            counts_available: true,
            seconds_since_last_input: None,
        }
    }

    /// Drives the aggregator one second at a time from `start` for `secs` seconds,
    /// `f(i)` giving the sample for second `i`. Returns emitted buckets.
    fn drive(
        agg: &mut ActivityAggregator,
        start: DateTime<Utc>,
        secs: u32,
        f: impl Fn(u32) -> InputSample,
    ) -> Vec<ActivityBucket> {
        let mut out = vec![];
        for i in 0..secs {
            let at = start + TimeDelta::seconds(i64::from(i) + 1);
            out.extend(agg.record(at, SEC, f(i)));
        }
        out
    }

    fn sum(buckets: &[ActivityBucket]) -> (u32, u32) {
        buckets.iter().fold((0, 0), |(a, i), b| {
            (a + b.active_seconds, i + b.idle_seconds)
        })
    }

    #[test]
    fn buckets_align_to_utc_minutes_across_boundaries() {
        let mut agg = ActivityAggregator::new(300);
        // Start at 09:00:30, run 150 s with constant input → ends 09:03:00.
        let out = drive(&mut agg, t(9, 0, 29), 151, |_| input(1));
        let starts: Vec<_> = out.iter().map(|b| b.bucket_start).collect();
        assert_eq!(starts, vec![t(9, 0, 0), t(9, 1, 0), t(9, 2, 0)]);
        assert_eq!(out[0].active_seconds, 30);
        assert_eq!(out[1].active_seconds, 60);
        assert_eq!(out[2].active_seconds, 60);
        assert_eq!(out[1].keyboard_count, 60);
        for b in &out {
            assert_eq!(b.bucket_start, floor_minute(b.bucket_start));
            assert!(b.active_seconds + b.idle_seconds <= 60);
            assert_eq!(b.data_quality, DataQuality::Ok);
        }
        // Second 09:03:00 is open in the 09:03 bucket.
        let rest = agg.flush_all();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].bucket_start, t(9, 3, 0));
        assert_eq!(rest[0].active_seconds, 1);
    }

    #[test]
    fn idle_is_attributed_back_to_start_of_run() {
        let mut agg = ActivityAggregator::new(60);
        // 30 s of input, then 150 s of nothing.
        let mut out = drive(&mut agg, t(9, 0, 0) - TimeDelta::seconds(1), 180, |i| {
            if i < 30 {
                input(2)
            } else {
                InputSample {
                    counts_available: true,
                    ..Default::default()
                }
            }
        });
        out.extend(agg.flush_all());
        // Minute 09:00: 30 active + 30 idle (the first 30 s of the idle run, attributed back).
        assert_eq!(out[0].bucket_start, t(9, 0, 0));
        assert_eq!((out[0].active_seconds, out[0].idle_seconds), (30, 30));
        assert_eq!((out[1].active_seconds, out[1].idle_seconds), (0, 60));
        assert_eq!((out[2].active_seconds, out[2].idle_seconds), (0, 60));
        assert_eq!(sum(&out), (30, 150));
    }

    #[test]
    fn os_reported_idle_time_is_used_when_available() {
        let mut agg = ActivityAggregator::new(120);
        // The OS says the user has been idle for 500 s already: idle immediately.
        let out = drive(&mut agg, t(9, 0, 0) - TimeDelta::seconds(1), 61, |i| InputSample {
            counts_available: true,
            seconds_since_last_input: Some(500.0 + f64::from(i)),
            ..Default::default()
        });
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].active_seconds, out[0].idle_seconds), (0, 60));
    }

    #[test]
    fn short_inactivity_counts_as_active_and_buckets_are_held_while_pending() {
        let mut agg = ActivityAggregator::new(120);
        let start = t(9, 0, 0) - TimeDelta::seconds(1);
        // 10 s input, 100 s nothing (spans a minute boundary), then input again.
        let out = drive(&mut agg, start, 110, |i| {
            if i < 10 {
                input(1)
            } else {
                InputSample {
                    counts_available: true,
                    ..Default::default()
                }
            }
        });
        assert!(out.is_empty(), "09:00 bucket must be held while seconds are pending");
        let out = agg.record(start + TimeDelta::seconds(111), SEC, input(1));
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].active_seconds, out[0].idle_seconds), (60, 0));
        let rest = agg.flush_all();
        assert_eq!(sum(&rest), (51, 0));
    }

    #[test]
    fn missing_permission_and_degraded_quality() {
        let mut agg = ActivityAggregator::new(60);
        let start = t(9, 0, 0) - TimeDelta::seconds(1);
        let out = drive(&mut agg, start, 61, |_| InputSample::default());
        assert_eq!(out[0].data_quality, DataQuality::PermissionMissing);
        assert_eq!((out[0].active_seconds, out[0].idle_seconds), (0, 0));

        // Counts unavailable but last-input time known → partial, still classified.
        let out = drive(&mut agg, t(9, 1, 0), 60, |_| InputSample {
            counts_available: false,
            keyboard_count: 99,
            mouse_count: 99,
            seconds_since_last_input: Some(0.2),
        });
        assert_eq!(out[0].bucket_start, t(9, 1, 0));
        // 09:01:00 itself had no data at all; the other 59 s are degraded but active.
        assert_eq!(out[0].data_quality, DataQuality::Partial);
        assert_eq!(out[0].active_seconds, 59);
        assert_eq!(out[0].keyboard_count, 0, "unavailable counts are never used");
    }

    #[test]
    fn interrupt_resolves_pending_and_parks_current_minute() {
        let mut agg = ActivityAggregator::new(300);
        let start = t(9, 0, 49);
        // 09:00:50..09:01:20 — 5 s input, then 26 s nothing (pending).
        let out = drive(&mut agg, start, 31, |i| {
            if i < 5 {
                input(1)
            } else {
                InputSample {
                    counts_available: true,
                    ..Default::default()
                }
            }
        });
        assert!(out.is_empty());
        // Pause at 09:01:20: minute 09:00 is emitted, 09:01 stays parked.
        let out = agg.interrupt(t(9, 1, 20));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].bucket_start, t(9, 0, 0));
        assert_eq!(out[0].active_seconds, 10);
        // Resume at 09:01:40 in the same minute: the parked bucket continues.
        let out = drive(&mut agg, t(9, 1, 40), 30, |_| input(1));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].bucket_start, t(9, 1, 0));
        // 21 s before the pause + 19 s after the resume.
        assert_eq!(out[0].active_seconds, 21 + 19);
        assert!(out[0].active_seconds <= 60);
    }

    #[test]
    fn never_emits_same_minute_twice_after_backwards_clock_change() {
        let mut agg = ActivityAggregator::new(300);
        let out = drive(&mut agg, t(9, 0, 0), 125, |_| input(1));
        assert_eq!(out.len(), 2);
        let out = agg.interrupt(t(9, 2, 5));
        assert!(out.is_empty());
        // Clock jumps back to 09:00:30: seconds for 09:00/09:01 are dropped.
        let out = drive(&mut agg, t(9, 0, 30), 30, |_| input(1));
        assert!(out.is_empty());
        assert_eq!(agg.dropped_seconds(), 30);
        let rest = agg.flush_all();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].bucket_start, t(9, 2, 0));
    }

    #[test]
    fn carries_sub_second_remainders_and_never_exceeds_sixty() {
        let mut agg = ActivityAggregator::new(300);
        let mut at = t(9, 0, 0);
        let mut out = vec![];
        // 200 ticks of 700 ms → 140 s.
        for _ in 0..200 {
            at += TimeDelta::milliseconds(700);
            out.extend(agg.record(at, Duration::from_millis(700), input(1)));
        }
        out.extend(agg.flush_all());
        let (a, i) = sum(&out);
        assert_eq!(a + i, 140);
        assert!(out.iter().all(|b| b.active_seconds + b.idle_seconds <= 60));
        let total_kb: u64 = out.iter().map(|b| b.keyboard_count).sum();
        assert_eq!(total_kb, 200);
    }
}
