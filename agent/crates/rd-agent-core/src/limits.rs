//! Work-limit warnings (Stage 4 F4): purely local heads-ups at 80% and 100% of the
//! daily and weekly limits the organization set.
//!
//! The server's figures ([`WorkLimits`], `GET /v1/device/work-limits`) leave out the
//! session the agent is running; the agent adds its own count of that session —
//! active + idle seconds, the same definition as the minute buckets it uploads,
//! including the current partial minute. Like the server, a session counts on the
//! local day (and week) it **started** on.
//!
//! Nothing here sends anything to the server, and a limit never stops or pauses a
//! session. Every function is pure: time comes in as `now`, so tests drive it with
//! any clock.

use std::time::Duration;

use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::WorkLimits;

/// How often the limits are fetched while a session is `Active`.
pub const LIMITS_REFRESH: Duration = Duration::from_secs(5 * 60);
/// Warning thresholds, in percent of the limit (ascending).
pub const THRESHOLDS: [u8; 2] = [80, 100];

/// Which limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitScope {
    /// Per local day.
    Daily,
    /// Per ISO week.
    Weekly,
}

impl LimitScope {
    fn key(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
        }
    }
}

impl WorkLimits {
    /// The time zone of the figures (UTC if the server sent a name this agent does not
    /// know).
    pub fn zone(&self) -> Tz {
        self.timezone.trim().parse().unwrap_or(Tz::UTC)
    }

    /// The person's local date at `now` in the figures' zone.
    pub fn date_at(&self, now: DateTime<Utc>) -> NaiveDate {
        now.with_timezone(&self.zone()).date_naive()
    }

    /// `true` while the figures are for today: a copy from an earlier day says nothing
    /// about today (or, after Sunday, this week) and is discarded.
    pub fn is_current(&self, now: DateTime<Utc>) -> bool {
        self.date_at(now) == self.today.date
    }
}

/// A session the server's figures do not include yet (the running one, and any started
/// after the figures were fetched), counted by the agent from its own buckets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UncountedSession {
    /// Session id.
    pub session_id: Uuid,
    /// When it started (decides the day and week it counts on).
    #[serde(with = "crate::ts")]
    pub started_at: DateTime<Utc>,
    /// Active + idle seconds of its emitted buckets.
    pub seconds: u64,
}

/// Keeps the sessions a newly fetched copy does not include: the one it was asked to
/// leave out, and any started after it was computed. Everything else is now in the
/// server's figures.
pub fn retain_uncounted(
    uncounted: &mut Vec<UncountedSession>,
    excluded: Option<Uuid>,
    as_of: DateTime<Utc>,
) {
    uncounted.retain(|s| Some(s.session_id) == excluded || s.started_at > as_of);
}

/// Progress against one limit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitProgress {
    /// Which limit.
    pub scope: LimitScope,
    /// The limit.
    pub limit_minutes: u32,
    /// Worked so far: the server's figure plus the agent's uncounted sessions.
    pub worked_seconds: u64,
    /// The period: today's date (daily) or the week's Monday (weekly).
    pub period: NaiveDate,
}

impl LimitProgress {
    /// The highest threshold reached (`100`, `80`), if any.
    pub fn reached(&self) -> Option<u8> {
        let limit = u64::from(self.limit_minutes) * 60;
        THRESHOLDS
            .iter()
            .rev()
            .copied()
            .find(|&p| self.worked_seconds * 100 >= limit * u64::from(p))
    }
}

/// Progress against each limit that is set, for `now`. Empty when the copy is not for
/// today. `partial_seconds` is the running session's not-yet-emitted seconds (its
/// current minute), added to `running`'s entry.
pub fn progress(
    limits: &WorkLimits,
    uncounted: &[UncountedSession],
    running: Option<Uuid>,
    partial_seconds: u64,
    now: DateTime<Utc>,
) -> Vec<LimitProgress> {
    if !limits.is_current(now) {
        return Vec::new();
    }
    let week_end = limits.week.period_start + TimeDelta::days(7);
    let (mut day, mut week) = (limits.today.worked_seconds, limits.week.worked_seconds);
    for s in uncounted {
        let secs = s.seconds
            + if Some(s.session_id) == running {
                partial_seconds
            } else {
                0
            };
        let on = limits.date_at(s.started_at);
        if on == limits.today.date {
            day += secs;
        }
        if on >= limits.week.period_start && on < week_end {
            week += secs;
        }
    }
    let mut out = Vec::new();
    if let Some(m) = limits.daily_minutes.filter(|&m| m > 0) {
        out.push(LimitProgress {
            scope: LimitScope::Daily,
            limit_minutes: m,
            worked_seconds: day,
            period: limits.today.date,
        });
    }
    if let Some(m) = limits.weekly_minutes.filter(|&m| m > 0) {
        out.push(LimitProgress {
            scope: LimitScope::Weekly,
            limit_minutes: m,
            worked_seconds: week,
            period: limits.week.period_start,
        });
    }
    out
}

/// Today's and this week's progress, for the popover ("5h 12m of 8h today").
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitSummary {
    /// Against the daily limit, if one is set.
    pub daily: Option<LimitProgress>,
    /// Against the weekly limit, if one is set.
    pub weekly: Option<LimitProgress>,
}

impl LimitSummary {
    /// From [`progress`]; `None` when no limit applies.
    pub fn of(progress: &[LimitProgress]) -> Option<Self> {
        let pick = |s: LimitScope| progress.iter().find(|p| p.scope == s).cloned();
        let out = Self {
            daily: pick(LimitScope::Daily),
            weekly: pick(LimitScope::Weekly),
        };
        (out.daily.is_some() || out.weekly.is_some()).then_some(out)
    }
}

/// A warning to show once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitWarning {
    /// Which limit.
    pub scope: LimitScope,
    /// `80` or `100`.
    pub percent: u8,
    /// The limit.
    pub limit_minutes: u32,
    /// Worked so far.
    pub worked_seconds: u64,
    /// The period it belongs to.
    pub period: NaiveDate,
}

impl LimitWarning {
    /// Stable id, unique per scope, period and threshold: `daily:2026-10-28:80`.
    pub fn id(&self) -> String {
        format!("{}:{}:{}", self.scope.key(), self.period, self.percent)
    }
}

/// The highest threshold already shown per scope and period (persisted, so a restart
/// does not repeat a warning).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitLedger {
    /// Daily: (date, highest percent shown).
    #[serde(default)]
    pub daily: Option<(NaiveDate, u8)>,
    /// Weekly: (week's Monday, highest percent shown).
    #[serde(default)]
    pub weekly: Option<(NaiveDate, u8)>,
}

impl LimitLedger {
    fn slot(&mut self, scope: LimitScope) -> &mut Option<(NaiveDate, u8)> {
        match scope {
            LimitScope::Daily => &mut self.daily,
            LimitScope::Weekly => &mut self.weekly,
        }
    }

    /// The warnings due for `progress`, recording them as shown. Each threshold fires
    /// at most once per period; when 100% is already reached, only that one is shown
    /// (80% is never shown after it).
    pub fn check(&mut self, progress: &[LimitProgress]) -> Vec<LimitWarning> {
        let mut out = Vec::new();
        for p in progress {
            let Some(percent) = p.reached() else {
                continue;
            };
            let slot = self.slot(p.scope);
            let shown = slot.filter(|(d, _)| *d == p.period).map_or(0, |(_, s)| s);
            if percent <= shown {
                continue;
            }
            *slot = Some((p.period, percent));
            out.push(LimitWarning {
                scope: p.scope,
                percent,
                limit_minutes: p.limit_minutes,
                worked_seconds: p.worked_seconds,
                period: p.period,
            });
        }
        out
    }
}

/// Everything F4 keeps between runs (outbox metadata, sealed like the rest).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitState {
    /// The last good copy (`None`: never fetched, or the plan has no work limits).
    #[serde(default)]
    pub limits: Option<WorkLimits>,
    /// Sessions the copy does not include.
    #[serde(default)]
    pub uncounted: Vec<UncountedSession>,
    /// Warnings already shown.
    #[serde(default)]
    pub ledger: LimitLedger,
}

impl LimitState {
    /// Applies a fetched copy (`None` = the plan has no work limits) that was asked to
    /// leave out `excluded`.
    pub fn on_fetched(&mut self, limits: Option<WorkLimits>, excluded: Option<Uuid>) {
        match &limits {
            Some(l) => retain_uncounted(&mut self.uncounted, excluded, l.as_of),
            None => self.uncounted.retain(|s| Some(s.session_id) == excluded),
        }
        self.limits = limits;
    }

    /// Drops a copy that is no longer for today (offline across midnight), and
    /// uncounted sessions older than a week. Returns `true` if anything changed.
    pub fn expire(&mut self, now: DateTime<Utc>) -> bool {
        let before = (self.limits.is_some(), self.uncounted.len());
        if self.limits.as_ref().is_some_and(|l| !l.is_current(now)) {
            self.limits = None;
        }
        let cutoff = now - TimeDelta::days(8);
        self.uncounted.retain(|s| s.started_at > cutoff);
        before != (self.limits.is_some(), self.uncounted.len())
    }

    /// Records a new session (not in any copy yet).
    pub fn session_started(&mut self, session_id: Uuid, started_at: DateTime<Utc>) {
        if !self.uncounted.iter().any(|s| s.session_id == session_id) {
            self.uncounted.push(UncountedSession {
                session_id,
                started_at,
                seconds: 0,
            });
        }
    }

    /// Adds emitted bucket seconds to `session_id`.
    pub fn add_seconds(&mut self, session_id: Uuid, seconds: u64) {
        if let Some(s) = self
            .uncounted
            .iter_mut()
            .find(|s| s.session_id == session_id)
        {
            s.seconds += seconds;
        }
    }

    /// Current progress (empty without a copy for today).
    pub fn progress(
        &self,
        running: Option<Uuid>,
        partial_seconds: u64,
        now: DateTime<Utc>,
    ) -> Vec<LimitProgress> {
        self.limits
            .as_ref()
            .map(|l| progress(l, &self.uncounted, running, partial_seconds, now))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{WorkedToday, WorkedWeek};
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        // Wednesday 28 October 2026.
        Utc.with_ymd_and_hms(2026, 10, 28, h, m, 0).unwrap()
    }

    fn date(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap()
    }

    fn limits(daily: Option<u32>, weekly: Option<u32>, today: u64, week: u64) -> WorkLimits {
        WorkLimits {
            as_of: at(12, 0),
            timezone: "UTC".into(),
            daily_minutes: daily,
            weekly_minutes: weekly,
            today: WorkedToday {
                date: date(28),
                worked_seconds: today,
            },
            week: WorkedWeek {
                period_start: date(26),
                worked_seconds: week,
            },
        }
    }

    fn sid(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn thresholds_round_down_never_up() {
        let p = |worked| LimitProgress {
            scope: LimitScope::Daily,
            limit_minutes: 480,
            worked_seconds: worked,
            period: date(28),
        };
        assert_eq!(p(0).reached(), None);
        assert_eq!(p(23_039).reached(), None, "one second short of 80%");
        assert_eq!(p(23_040).reached(), Some(80));
        assert_eq!(p(28_799).reached(), Some(80));
        assert_eq!(p(28_800).reached(), Some(100));
        assert_eq!(p(40_000).reached(), Some(100));
    }

    #[test]
    fn eighty_then_hundred_once_each() {
        let mut state = LimitState::default();
        state.on_fetched(Some(limits(Some(480), None, 6 * 3600, 0)), Some(sid(1)));
        state.session_started(sid(1), at(13, 0));
        // 6 h from the server: 75%.
        assert!(state
            .ledger
            .check(&state.progress(Some(sid(1)), 0, at(13, 0)))
            .is_empty());
        // + 24 min of the running session → 6 h 24 min = 80%.
        state.add_seconds(sid(1), 23 * 60);
        assert!(state
            .ledger
            .check(&state.progress(Some(sid(1)), 59, at(13, 24)))
            .is_empty());
        let w = state
            .ledger
            .check(&state.progress(Some(sid(1)), 60, at(13, 24)));
        assert_eq!(w.len(), 1, "the current partial minute counts");
        assert_eq!((w[0].scope, w[0].percent), (LimitScope::Daily, 80));
        assert_eq!(w[0].worked_seconds, 6 * 3600 + 24 * 60);
        assert_eq!(w[0].id(), "daily:2026-10-28:80");
        // No repeat at 80%…
        state.add_seconds(sid(1), 60 * 60);
        assert!(state
            .ledger
            .check(&state.progress(Some(sid(1)), 0, at(14, 30)))
            .is_empty());
        // …then 100% once.
        state.add_seconds(sid(1), 37 * 60);
        let w = state
            .ledger
            .check(&state.progress(Some(sid(1)), 0, at(15, 0)));
        assert_eq!(w.iter().map(|w| w.percent).collect::<Vec<_>>(), [100]);
        state.add_seconds(sid(1), 3600);
        assert!(state
            .ledger
            .check(&state.progress(Some(sid(1)), 0, at(16, 0)))
            .is_empty());
    }

    #[test]
    fn already_over_shows_only_the_hundred() {
        let mut ledger = LimitLedger::default();
        let l = limits(Some(480), None, 9 * 3600, 0);
        let w = ledger.check(&progress(&l, &[], None, 0, at(18, 0)));
        assert_eq!(w.iter().map(|w| w.percent).collect::<Vec<_>>(), [100]);
        assert!(ledger
            .check(&progress(&l, &[], None, 0, at(18, 5)))
            .is_empty());
    }

    #[test]
    fn no_repeat_after_a_restart() {
        let mut state = LimitState::default();
        state.on_fetched(
            Some(limits(Some(480), Some(2400), 7 * 3600, 7 * 3600)),
            None,
        );
        assert_eq!(
            state
                .ledger
                .check(&state.progress(None, 0, at(16, 0)))
                .len(),
            1
        );
        // Persisted and loaded again, as on the next start.
        let json = serde_json::to_string(&state).unwrap();
        let mut again: LimitState = serde_json::from_str(&json).unwrap();
        assert_eq!(again, state);
        assert!(again
            .ledger
            .check(&again.progress(None, 0, at(16, 1)))
            .is_empty());
        // An older document without the new fields still loads.
        let empty: LimitState = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, LimitState::default());
    }

    #[test]
    fn daily_and_weekly_are_keyed_separately() {
        let mut ledger = LimitLedger::default();
        // 6 h 30 min today (81%) and 32 h this week (80%).
        let l = limits(Some(480), Some(2400), 6 * 3600 + 1800, 32 * 3600);
        let w = ledger.check(&progress(&l, &[], None, 0, at(16, 0)));
        let ids: Vec<_> = w.iter().map(LimitWarning::id).collect();
        assert_eq!(ids, ["daily:2026-10-28:80", "weekly:2026-10-26:80"]);

        // The next day: a new daily period, the same week (already warned at 80%).
        let mut l = limits(Some(480), Some(2400), 6 * 3600 + 1800, 33 * 3600);
        l.today.date = date(29);
        let next = Utc.with_ymd_and_hms(2026, 10, 29, 16, 0, 0).unwrap();
        let ids: Vec<_> = ledger
            .check(&progress(&l, &[], None, 0, next))
            .iter()
            .map(LimitWarning::id)
            .collect();
        assert_eq!(ids, ["daily:2026-10-29:80"]);
        // The next week starts over.
        let mut l = limits(None, Some(2400), 0, 33 * 3600);
        l.today.date = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        l.week.period_start = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        let monday = Utc.with_ymd_and_hms(2026, 11, 2, 10, 0, 0).unwrap();
        let ids: Vec<_> = ledger
            .check(&progress(&l, &[], None, 0, monday))
            .iter()
            .map(LimitWarning::id)
            .collect();
        assert_eq!(ids, ["weekly:2026-11-02:80"]);
    }

    #[test]
    fn uncounted_sessions_count_on_the_day_they_started() {
        let mut l = limits(Some(480), Some(2400), 3600, 10 * 3600);
        l.timezone = "Europe/Riga".into(); // UTC+2 in late October
        let now = at(12, 0); // 14:00 in Riga, 28 Oct
        let uncounted = [
            // Started 22:30 UTC on 27 Oct = 00:30 on 28 Oct in Riga: today.
            UncountedSession {
                session_id: sid(1),
                started_at: Utc.with_ymd_and_hms(2026, 10, 27, 22, 30, 0).unwrap(),
                seconds: 600,
            },
            // Started 21:30 UTC on 27 Oct = 23:30 on 27 Oct in Riga: this week, not today.
            UncountedSession {
                session_id: sid(2),
                started_at: Utc.with_ymd_and_hms(2026, 10, 27, 21, 30, 0).unwrap(),
                seconds: 300,
            },
            // Last week: neither.
            UncountedSession {
                session_id: sid(3),
                started_at: Utc.with_ymd_and_hms(2026, 10, 24, 10, 0, 0).unwrap(),
                seconds: 9999,
            },
        ];
        let p = progress(&l, &uncounted, Some(sid(1)), 30, now);
        assert_eq!(p[0].worked_seconds, 3600 + 600 + 30);
        assert_eq!(p[1].worked_seconds, 10 * 3600 + 600 + 30 + 300);
        let s = LimitSummary::of(&p).unwrap();
        assert_eq!(s.daily.unwrap().limit_minutes, 480);
        assert_eq!(s.weekly.unwrap().limit_minutes, 2400);
    }

    #[test]
    fn unset_or_zero_limits_never_warn() {
        let mut ledger = LimitLedger::default();
        let l = limits(None, Some(0), 99_999, 999_999);
        let p = progress(&l, &[], None, 0, at(12, 0));
        assert!(p.is_empty());
        assert!(ledger.check(&p).is_empty());
        assert_eq!(LimitSummary::of(&p), None);
    }

    #[test]
    fn offline_cache_is_kept_for_today_and_dropped_after_midnight() {
        let mut state = LimitState::default();
        let mut l = limits(Some(480), None, 3600, 3600);
        l.timezone = "America/New_York".into(); // UTC-4 on 28 Oct
        state.on_fetched(Some(l), Some(sid(1)));
        state.session_started(sid(1), at(14, 0));
        state.add_seconds(sid(1), 1200);
        // Offline: nothing new arrives, the copy is still for today in New York.
        assert!(!state.expire(at(23, 0)));
        assert_eq!(
            state.progress(Some(sid(1)), 0, at(23, 0))[0].worked_seconds,
            4800
        );
        // 03:59 UTC on 29 Oct is still 23:59 on 28 Oct in New York.
        let late = Utc.with_ymd_and_hms(2026, 10, 29, 3, 59, 0).unwrap();
        assert!(!state.expire(late));
        assert_eq!(state.progress(Some(sid(1)), 0, late).len(), 1);
        // Midnight there: the copy says nothing about the new day.
        let midnight = Utc.with_ymd_and_hms(2026, 10, 29, 4, 0, 0).unwrap();
        assert!(state.progress(Some(sid(1)), 0, midnight).is_empty());
        assert!(state.expire(midnight));
        assert_eq!(state.limits, None);
        assert_eq!(
            state.uncounted.len(),
            1,
            "the session is still not on the server"
        );
        // A week later the leftover entry goes too.
        assert!(state.expire(at(14, 0) + TimeDelta::days(9)));
        assert!(state.uncounted.is_empty());
    }

    #[test]
    fn a_new_copy_includes_finished_sessions() {
        let mut state = LimitState::default();
        state.session_started(sid(1), at(9, 0));
        state.add_seconds(sid(1), 3600);
        state.session_started(sid(2), at(11, 0));
        state.add_seconds(sid(2), 60);
        // Fetched at 11:05 leaving out session 2: session 1 is in the server's figures.
        let mut l = limits(Some(480), None, 3600, 3600);
        l.as_of = at(11, 5);
        state.on_fetched(Some(l), Some(sid(2)));
        assert_eq!(
            state
                .uncounted
                .iter()
                .map(|s| s.session_id)
                .collect::<Vec<_>>(),
            [sid(2)]
        );
        // A session that started after the copy was computed is kept.
        state.session_started(sid(3), at(11, 10));
        let mut l = limits(Some(480), None, 3600, 3600);
        l.as_of = at(11, 6);
        state.on_fetched(Some(l), Some(sid(2)));
        assert_eq!(state.uncounted.len(), 2);
        // Plans without limits: no copy.
        state.on_fetched(None, Some(sid(3)));
        assert_eq!(state.limits, None);
        assert!(state.progress(Some(sid(3)), 0, at(12, 0)).is_empty());
    }

    #[test]
    fn unknown_zone_falls_back_to_utc() {
        let mut l = limits(Some(60), None, 0, 0);
        l.timezone = "Mars/Olympus".into();
        assert_eq!(l.zone(), Tz::UTC);
        assert!(l.is_current(at(23, 59)));
    }
}
