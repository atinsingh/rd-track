//! Start / stop / "still tracking?" reminders (Stage 4 F3): local nudges inside the
//! person's working hours, controlled by the employee.
//!
//! Today's window comes from the organization's schedule when there is one
//! ([`ScheduleToday`], `GET /v1/device/schedule-today`), else from the hours the person
//! set ([`MyHours`], device-local time):
//!
//! | schedule today | window |
//! |---|---|
//! | `day_off` set | none — no reminders |
//! | `scheduled`, shift | `[start_at, end_at]` |
//! | `scheduled`, no shift | none — not a working day |
//! | not scheduled, or unknown (never fetched, older server) | my hours, on my workdays |
//!
//! The reminders, each at most once per window day (the ledger is persisted):
//!
//! * **Start** — at window start + 10 min, while inside the window, only if nothing is
//!   tracking and no session ran today. "Not today" suppresses it for the day.
//! * **Stop** — at window end + 10 min (the first `Active` moment from then on) while a
//!   session is active. A session started after that moment gets no stop reminder; its
//!   "still tracking?" cadence starts from its start instead.
//! * **Still tracking?** — every 60 min after the stop reminder while the same session
//!   stays active (it follows the session across midnight).
//!
//! A paused session gets nothing, and a pending reminder whose condition no longer holds
//! is withdrawn. Nothing is sent to the server. Every function is pure (time comes in
//! as `now`, the local zone as a parameter), so tests drive it with any clock.

use std::time::Duration;

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeDelta, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::ScheduleToday;

/// How often today's schedule is fetched (also at startup and when the date changes).
pub const SCHEDULE_REFRESH: Duration = Duration::from_secs(60 * 60);
/// Delay after the window opens / closes before the start / stop reminder.
pub const REMINDER_DELAY: TimeDelta = TimeDelta::minutes(10);
/// Interval of "still tracking?" reminders.
pub const STILL_TRACKING_EVERY: TimeDelta = TimeDelta::minutes(60);

/// `HH:MM` (de)serialization for [`NaiveTime`].
mod hhmm {
    use chrono::NaiveTime;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &NaiveTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&t.format("%H:%M").to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<NaiveTime, D::Error> {
        let s = String::deserialize(d)?;
        super::parse_hhmm(&s).ok_or_else(|| serde::de::Error::custom("expected HH:MM"))
    }
}

/// Parses local `HH:MM`.
pub fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

/// The hours the person works, used only when there is no organization schedule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MyHours {
    /// Local start.
    #[serde(with = "hhmm")]
    pub start: NaiveTime,
    /// Local end (after `start`, same day).
    #[serde(with = "hhmm")]
    pub end: NaiveTime,
    /// ISO weekdays (1 = Monday … 7 = Sunday).
    pub days: Vec<u8>,
}

impl Default for MyHours {
    /// Monday–Friday, 09:00–17:30.
    fn default() -> Self {
        Self {
            start: NaiveTime::from_hms_opt(9, 0, 0).unwrap_or_default(),
            end: NaiveTime::from_hms_opt(17, 30, 0).unwrap_or_default(),
            days: vec![1, 2, 3, 4, 5],
        }
    }
}

/// The employee's reminder settings (local only; never sent anywhere).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReminderSettings {
    /// Master switch.
    pub enabled: bool,
    /// Start reminder.
    pub start: bool,
    /// Stop reminder.
    pub stop: bool,
    /// "Still tracking?" reminders.
    pub still_tracking: bool,
    /// Hours used when there is no organization schedule.
    pub my_hours: MyHours,
}

impl Default for ReminderSettings {
    /// Everything on, Monday–Friday 09:00–17:30.
    fn default() -> Self {
        Self {
            enabled: true,
            start: true,
            stop: true,
            still_tracking: true,
            my_hours: MyHours::default(),
        }
    }
}

impl ReminderSettings {
    /// Checks the hours and normalises the workdays (sorted, no duplicates). The error
    /// is shown to the person.
    pub fn validated(mut self) -> Result<Self, &'static str> {
        if self.my_hours.end <= self.my_hours.start {
            return Err("The end of your hours must be after the start.");
        }
        if self.my_hours.days.iter().any(|d| !(1..=7).contains(d)) {
            return Err("Unknown workday.");
        }
        self.my_hours.days.sort_unstable();
        self.my_hours.days.dedup();
        Ok(self)
    }
}

/// Where today's hours come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoursSource {
    /// The organization's schedule (a shift).
    Organization,
    /// The hours the person set.
    Mine,
}

/// Today's reminder window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderWindow {
    /// The day it belongs to (dedupes reminders).
    pub date: NaiveDate,
    /// Start.
    #[serde(with = "crate::ts")]
    pub start: DateTime<Utc>,
    /// End.
    #[serde(with = "crate::ts")]
    pub end: DateTime<Utc>,
    /// Schedule or own hours.
    pub source: HoursSource,
}

impl ScheduleToday {
    /// The zone of [`ScheduleToday::date`] (UTC for a name this agent does not know).
    pub fn zone(&self) -> Tz {
        self.timezone.trim().parse().unwrap_or(Tz::UTC)
    }

    /// `true` while this is today's schedule.
    pub fn is_current(&self, now: DateTime<Utc>) -> bool {
        now.with_timezone(&self.zone()).date_naive() == self.date
    }

    /// The organization's schedule decides today's hours (the tray then shows "Your
    /// organization's schedule sets these hours" instead of the hours editor).
    pub fn applies(&self) -> bool {
        self.scheduled || self.day_off.is_some()
    }
}

/// `date` at local `time` in `tz`, as UTC. In a spring-forward gap the time is moved
/// one hour later; in a fall-back overlap the earlier instant is used.
pub fn local_instant<Z: TimeZone>(
    tz: &Z,
    date: NaiveDate,
    time: NaiveTime,
) -> Option<DateTime<Utc>> {
    let ndt = date.and_time(time);
    tz.from_local_datetime(&ndt)
        .earliest()
        .or_else(|| {
            tz.from_local_datetime(&(ndt + TimeDelta::hours(1)))
                .earliest()
        })
        .map(|t| t.with_timezone(&Utc))
}

/// Today's window at `now`. `schedule` is the cached copy (ignored unless it is for
/// today); `local` is the device's zone, which "my hours" are in.
pub fn window_today<Z: TimeZone>(
    now: DateTime<Utc>,
    local: &Z,
    schedule: Option<&ScheduleToday>,
    mine: &MyHours,
) -> Option<ReminderWindow> {
    if let Some(s) = schedule.filter(|s| s.is_current(now)) {
        if s.day_off.is_some() {
            return None;
        }
        if s.scheduled {
            let shift = s.shift.as_ref()?;
            return (shift.end_at > shift.start_at).then_some(ReminderWindow {
                date: s.date,
                start: shift.start_at,
                end: shift.end_at,
                source: HoursSource::Organization,
            });
        }
    }
    let date = now.with_timezone(local).date_naive();
    let weekday = u8::try_from(date.weekday().number_from_monday()).unwrap_or(0);
    if !mine.days.contains(&weekday) {
        return None;
    }
    let start = local_instant(local, date, mine.start)?;
    let end = local_instant(local, date, mine.end)?;
    (end > start).then_some(ReminderWindow {
        date,
        start,
        end,
        source: HoursSource::Mine,
    })
}

/// Which reminder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderKind {
    /// "Start tracking?"
    Start,
    /// The hours ended and a session is still active.
    Stop,
    /// Every hour after that while it stays active.
    StillTracking,
}

/// The person's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderChoice {
    /// "Start tracking" (the tray then runs its usual start flow).
    Start,
    /// "Not today": no start reminder again today.
    NotToday,
    /// "Stop tracking": stops the session.
    Stop,
    /// "Keep tracking".
    Keep,
}

impl ReminderChoice {
    /// Whether the choice answers a reminder of `kind`.
    pub fn answers(self, kind: ReminderKind) -> bool {
        match self {
            Self::Start | Self::NotToday => kind == ReminderKind::Start,
            Self::Stop | Self::Keep => kind != ReminderKind::Start,
        }
    }
}

/// "Still tracking?" cadence of one session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cadence {
    /// The session.
    pub session_id: Uuid,
    /// The last reminder (or the start of a session begun after the stop time).
    #[serde(with = "crate::ts")]
    pub last_at: DateTime<Utc>,
    /// When the hours it relates to ended (for the wording).
    #[serde(with = "crate::ts")]
    pub hours_end: DateTime<Utc>,
}

/// What was already shown (persisted, so a restart repeats nothing).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReminderLedger {
    /// The window day the flags below belong to.
    pub date: Option<NaiveDate>,
    /// The start reminder was shown (or is no longer needed) today.
    pub start_done: bool,
    /// The person chose "Not today".
    pub not_today: bool,
    /// The stop reminder was shown (or skipped) today.
    pub stop_done: bool,
    /// A session was open at some point today.
    pub session_seen: bool,
    /// "Still tracking?" cadence (follows the session, not the day).
    pub cadence: Option<Cadence>,
}

impl ReminderLedger {
    fn roll(&mut self, date: NaiveDate) {
        if self.date != Some(date) {
            *self = Self {
                date: Some(date),
                cadence: self.cadence.take(),
                ..Self::default()
            };
        }
    }
}

/// The tracking state reminders look at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tracking {
    /// No open session.
    Idle,
    /// A session is `Active` (or briefly suspended).
    Active {
        /// The session.
        session_id: Uuid,
        /// Its wall-clock start.
        started_at: DateTime<Utc>,
    },
    /// The session is paused: no reminders.
    Paused,
}

/// Inputs to [`step`].
#[derive(Debug, Clone)]
pub struct ReminderInput<'a> {
    /// Now.
    pub now: DateTime<Utc>,
    /// The employee's settings.
    pub settings: &'a ReminderSettings,
    /// Today's window ([`window_today`]).
    pub window: Option<&'a ReminderWindow>,
    /// What is tracking.
    pub tracking: Tracking,
    /// Time was tracked today on this device (a session ran today).
    pub ran_today: bool,
    /// A session can be started (no licence refusal).
    pub can_start: bool,
    /// The reminder currently shown, if any.
    pub pending: Option<ReminderKind>,
}

/// What [`step`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReminderStep {
    /// Nothing changes.
    Nothing,
    /// Show this reminder (replacing a pending one). `hours` are the start and end of
    /// the hours it relates to.
    Show {
        /// Which reminder.
        kind: ReminderKind,
        /// Start of the hours.
        hours_start: Option<DateTime<Utc>>,
        /// End of the hours.
        hours_end: DateTime<Utc>,
        /// Where the hours come from.
        source: HoursSource,
    },
    /// Withdraw the pending reminder (its condition no longer holds).
    Clear,
}

fn pending_still_valid(i: &ReminderInput<'_>, kind: ReminderKind) -> bool {
    let s = i.settings;
    match kind {
        ReminderKind::Start => {
            s.start
                && i.can_start
                && i.tracking == Tracking::Idle
                && i.window.is_some_and(|w| i.now < w.end)
        }
        ReminderKind::Stop => s.stop && matches!(i.tracking, Tracking::Active { .. }),
        ReminderKind::StillTracking => {
            s.still_tracking && matches!(i.tracking, Tracking::Active { .. })
        }
    }
}

/// One evaluation (every tick). Updates `ledger` and says what to show.
pub fn step(ledger: &mut ReminderLedger, i: &ReminderInput<'_>) -> ReminderStep {
    let s = i.settings;
    if let Some(w) = i.window {
        ledger.roll(w.date);
    }
    if i.tracking != Tracking::Idle {
        ledger.session_seen = true;
    }
    if let Tracking::Active { session_id, .. } = i.tracking {
        if ledger
            .cadence
            .as_ref()
            .is_some_and(|c| c.session_id != session_id)
        {
            ledger.cadence = None;
        }
    }
    let invalid = i
        .pending
        .is_some_and(|k| !s.enabled || !pending_still_valid(i, k));
    if !s.enabled {
        return if invalid {
            ReminderStep::Clear
        } else {
            ReminderStep::Nothing
        };
    }
    let none = if invalid {
        ReminderStep::Clear
    } else {
        ReminderStep::Nothing
    };
    match i.tracking {
        Tracking::Paused => none,
        Tracking::Idle => {
            let Some(w) = i.window else {
                return none;
            };
            let due = i.now >= w.start + REMINDER_DELAY && i.now < w.end;
            if s.start
                && i.can_start
                && due
                && !ledger.start_done
                && !ledger.session_seen
                && !i.ran_today
            {
                ledger.start_done = true;
                return ReminderStep::Show {
                    kind: ReminderKind::Start,
                    hours_start: Some(w.start),
                    hours_end: w.end,
                    source: w.source,
                };
            }
            none
        }
        Tracking::Active {
            session_id,
            started_at,
        } => {
            if let Some(w) = i.window {
                let due_at = w.end + REMINDER_DELAY;
                if i.now >= due_at {
                    if started_at > due_at {
                        // Started after the hours: no "your hours ended" right away,
                        // only the hourly check, counted from the session's start.
                        ledger.stop_done = true;
                        if ledger.cadence.is_none() {
                            ledger.cadence = Some(Cadence {
                                session_id,
                                last_at: started_at,
                                hours_end: w.end,
                            });
                        }
                    } else if !ledger.stop_done {
                        ledger.stop_done = true;
                        ledger.cadence = Some(Cadence {
                            session_id,
                            last_at: i.now,
                            hours_end: w.end,
                        });
                        if s.stop {
                            return ReminderStep::Show {
                                kind: ReminderKind::Stop,
                                hours_start: Some(w.start),
                                hours_end: w.end,
                                source: w.source,
                            };
                        }
                    }
                }
            }
            if let Some(c) = ledger.cadence.as_mut() {
                if s.still_tracking && i.now >= c.last_at + STILL_TRACKING_EVERY {
                    c.last_at = i.now;
                    let hours_end = c.hours_end;
                    return ReminderStep::Show {
                        kind: ReminderKind::StillTracking,
                        hours_start: None,
                        hours_end,
                        source: i.window.map_or(HoursSource::Mine, |w| w.source),
                    };
                }
            }
            none
        }
    }
}

/// Records the person's answer in the ledger.
pub fn answer(ledger: &mut ReminderLedger, choice: ReminderChoice) {
    if choice == ReminderChoice::NotToday {
        ledger.not_today = true;
        ledger.start_done = true;
    }
}

/// `true` when `last` (monotonic) is unset or at least `every` ago.
pub fn refresh_due(last: Option<Duration>, now: Duration, every: Duration) -> bool {
    last.is_none_or(|l| now.saturating_sub(l) >= every)
}

/// Everything F3 keeps between runs (outbox metadata).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReminderState {
    /// The employee's settings.
    pub settings: ReminderSettings,
    /// The last schedule fetched (`None`: never, or the server has no schedules).
    pub schedule: Option<ScheduleToday>,
    /// What was shown.
    pub ledger: ReminderLedger,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{DayOff, ScheduledShift};
    use chrono::FixedOffset;

    // Wednesday 28 October 2026, device on UTC unless a test says otherwise.
    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, h, m, 0).unwrap()
    }

    fn day(d: u32, h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, d, h, m, 0).unwrap()
    }

    fn date(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap()
    }

    fn schedule(scheduled: bool, shift: Option<(u32, u32)>, off: Option<DayOff>) -> ScheduleToday {
        ScheduleToday {
            date: date(28),
            timezone: "UTC".into(),
            scheduled,
            shift: shift.map(|(a, b)| ScheduledShift {
                start_at: at(a, 0),
                end_at: at(b, 0),
            }),
            day_off: off,
        }
    }

    const SID: Uuid = Uuid::from_u128(7);

    /// Drives [`step`] minute by minute and records what is shown.
    struct Sim {
        settings: ReminderSettings,
        schedule: Option<ScheduleToday>,
        ledger: ReminderLedger,
        pending: Option<ReminderKind>,
        tracking: Tracking,
        ran_today: bool,
        shown: Vec<(DateTime<Utc>, ReminderKind)>,
    }

    impl Sim {
        fn new() -> Self {
            Self {
                settings: ReminderSettings::default(),
                schedule: None,
                ledger: ReminderLedger::default(),
                pending: None,
                tracking: Tracking::Idle,
                ran_today: false,
                shown: Vec::new(),
            }
        }

        fn at(&mut self, now: DateTime<Utc>) -> ReminderStep {
            let w = window_today(now, &Utc, self.schedule.as_ref(), &self.settings.my_hours);
            let input = ReminderInput {
                now,
                settings: &self.settings,
                window: w.as_ref(),
                tracking: self.tracking,
                ran_today: self.ran_today,
                can_start: true,
                pending: self.pending,
            };
            let r = step(&mut self.ledger, &input);
            match &r {
                ReminderStep::Show { kind, .. } => {
                    self.pending = Some(*kind);
                    self.shown.push((now, *kind));
                }
                ReminderStep::Clear => self.pending = None,
                ReminderStep::Nothing => {}
            }
            r
        }

        /// Every minute in [from, to).
        fn run(&mut self, from: DateTime<Utc>, to: DateTime<Utc>) {
            let mut t = from;
            while t < to {
                self.at(t);
                t += TimeDelta::minutes(1);
            }
        }

        fn kinds(&self) -> Vec<(String, ReminderKind)> {
            self.shown
                .iter()
                .map(|(t, k)| (t.format("%d %H:%M").to_string(), *k))
                .collect()
        }
    }

    fn active(started_at: DateTime<Utc>) -> Tracking {
        Tracking::Active {
            session_id: SID,
            started_at,
        }
    }

    #[test]
    fn default_settings_are_on_with_weekday_hours() {
        let s = ReminderSettings::default();
        assert!(s.enabled && s.start && s.stop && s.still_tracking);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json["my_hours"],
            serde_json::json!({"start": "09:00", "end": "17:30", "days": [1, 2, 3, 4, 5]})
        );
        // Missing fields take the defaults (older or partial documents).
        let partial: ReminderSettings =
            serde_json::from_value(serde_json::json!({"stop": false})).unwrap();
        assert!(partial.enabled && !partial.stop);
        assert_eq!(partial.my_hours, MyHours::default());
        assert!(serde_json::from_value::<MyHours>(serde_json::json!({"start": "9am"})).is_err());
    }

    #[test]
    fn settings_validation() {
        let mut s = ReminderSettings::default();
        s.my_hours.days = vec![5, 1, 1, 3];
        assert_eq!(s.clone().validated().unwrap().my_hours.days, [1, 3, 5]);
        s.my_hours.end = s.my_hours.start;
        assert!(s.clone().validated().is_err());
        let mut s = ReminderSettings::default();
        s.my_hours.days = vec![0];
        assert!(s.validated().is_err());
    }

    #[test]
    fn windows_from_schedule_day_off_weekend_and_own_hours() {
        let mine = MyHours::default();
        // No schedule (or never fetched): my hours, on my workdays.
        let w = window_today(at(12, 0), &Utc, None, &mine).unwrap();
        assert_eq!(
            (w.start, w.end, w.source),
            (at(9, 0), at(17, 30), HoursSource::Mine)
        );
        let unscheduled = schedule(false, None, None);
        assert_eq!(
            window_today(at(12, 0), &Utc, Some(&unscheduled), &mine),
            Some(w.clone())
        );
        // A shift.
        let shifted = schedule(true, Some((8, 16)), None);
        let s = window_today(at(12, 0), &Utc, Some(&shifted), &mine).unwrap();
        assert_eq!(
            (s.start, s.end, s.source),
            (at(8, 0), at(16, 0), HoursSource::Organization)
        );
        assert!(shifted.applies() && !unscheduled.applies());
        // Scheduled but no shift today: not a working day.
        assert_eq!(
            window_today(at(12, 0), &Utc, Some(&schedule(true, None, None)), &mine),
            None
        );
        // A day off, even with a shift.
        for off in [DayOff::Holiday, DayOff::Cancelled, DayOff::Leave] {
            let s = schedule(true, Some((8, 16)), Some(off));
            assert_eq!(window_today(at(12, 0), &Utc, Some(&s), &mine), None);
            assert!(s.applies());
        }
        assert_eq!(
            window_today(
                at(12, 0),
                &Utc,
                Some(&schedule(false, None, Some(DayOff::Leave))),
                &mine
            ),
            None
        );
        // Yesterday's schedule says nothing about today: my hours.
        let mut old = schedule(true, None, Some(DayOff::Holiday));
        old.date = date(27);
        assert_eq!(
            window_today(at(12, 0), &Utc, Some(&old), &mine)
                .unwrap()
                .source,
            HoursSource::Mine
        );
        // Weekend: not one of my days.
        assert_eq!(window_today(day(31, 12, 0), &Utc, None, &mine), None);
        // My hours are device-local time.
        let riga = FixedOffset::east_opt(2 * 3600).unwrap();
        let w = window_today(at(12, 0), &riga, None, &mine).unwrap();
        assert_eq!((w.start, w.end), (at(7, 0), at(15, 30)));
        // …and the local date decides the weekday: Saturday 00:30 in Riga is Friday 22:30 UTC.
        assert_eq!(window_today(day(30, 22, 30), &riga, None, &mine), None);
    }

    #[test]
    fn local_instants_across_dst() {
        let riga: Tz = "Europe/Riga".parse().unwrap();
        // 25 Oct 2026: 04:00 → 03:00 (fall back); 03:30 exists twice, the earlier wins.
        let t = local_instant(&riga, date(25), NaiveTime::from_hms_opt(3, 30, 0).unwrap()).unwrap();
        assert_eq!(t, day(25, 0, 30));
        // 29 Mar 2026: 03:00 → 04:00 (spring forward); 03:30 does not exist → 04:30.
        let march = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
        let t = local_instant(&riga, march, NaiveTime::from_hms_opt(3, 30, 0).unwrap()).unwrap();
        assert_eq!(t, Utc.with_ymd_and_hms(2026, 3, 29, 1, 30, 0).unwrap());
    }

    #[test]
    fn start_reminder_once_ten_minutes_into_the_window() {
        let mut sim = Sim::new();
        sim.run(at(6, 0), at(23, 0));
        assert_eq!(sim.kinds(), [("28 09:10".to_owned(), ReminderKind::Start)]);
        // Still pending at 17:29, withdrawn when the window ends.
        sim.ledger = ReminderLedger::default();
        sim.pending = None;
        sim.at(at(9, 10));
        assert_eq!(sim.at(at(17, 29)), ReminderStep::Nothing);
        assert_eq!(sim.at(at(17, 30)), ReminderStep::Clear);
    }

    #[test]
    fn start_reminder_not_after_a_session_today_or_while_tracking() {
        // Time was tracked earlier today on this device.
        let mut sim = Sim::new();
        sim.ran_today = true;
        sim.run(at(9, 0), at(17, 0));
        assert!(sim.shown.is_empty());
        // A session started and stopped before 09:10 (seen by the reminders).
        let mut sim = Sim::new();
        sim.tracking = active(at(8, 0));
        sim.run(at(8, 0), at(8, 30));
        sim.tracking = Tracking::Idle;
        sim.run(at(8, 30), at(17, 0));
        assert!(sim.shown.is_empty());
        // Tracking (or paused) at 09:10: nothing; and once a session runs, no start later.
        let mut sim = Sim::new();
        sim.tracking = Tracking::Paused;
        sim.run(at(9, 0), at(10, 0));
        sim.tracking = Tracking::Idle;
        sim.run(at(10, 0), at(17, 0));
        assert!(sim.shown.is_empty());
        // Licence refused: no point asking.
        let mut ledger = ReminderLedger::default();
        let settings = ReminderSettings::default();
        let w = window_today(at(9, 10), &Utc, None, &settings.my_hours);
        let i = ReminderInput {
            now: at(9, 10),
            settings: &settings,
            window: w.as_ref(),
            tracking: Tracking::Idle,
            ran_today: false,
            can_start: false,
            pending: None,
        };
        assert_eq!(step(&mut ledger, &i), ReminderStep::Nothing);
    }

    #[test]
    fn starting_a_session_withdraws_the_start_reminder() {
        let mut sim = Sim::new();
        sim.run(at(9, 0), at(9, 20));
        assert_eq!(sim.pending, Some(ReminderKind::Start));
        sim.tracking = active(at(9, 20));
        assert_eq!(sim.at(at(9, 20)), ReminderStep::Clear);
    }

    #[test]
    fn not_today_suppresses_the_start_reminder_for_the_day() {
        let mut sim = Sim::new();
        // Before it is even shown (e.g. answered from an earlier one): nothing today.
        answer(&mut sim.ledger, ReminderChoice::NotToday);
        sim.ledger.date = Some(date(28));
        sim.run(at(9, 0), at(17, 30));
        assert!(sim.shown.is_empty());
        assert!(sim.ledger.not_today);
        // Persisted: a restart does not bring it back.
        let mut again: ReminderLedger =
            serde_json::from_str(&serde_json::to_string(&sim.ledger).unwrap()).unwrap();
        sim.ledger = std::mem::take(&mut again);
        sim.run(at(12, 0), at(13, 0));
        assert!(sim.shown.is_empty());
        // The next workday it is back.
        sim.run(day(29, 9, 0), day(29, 9, 15));
        assert_eq!(sim.kinds(), [("29 09:10".to_owned(), ReminderKind::Start)]);
        assert!(!sim.ledger.not_today);
    }

    #[test]
    fn stop_then_still_tracking_every_hour() {
        let mut sim = Sim::new();
        sim.ran_today = true;
        sim.tracking = active(at(9, 0));
        sim.run(at(9, 0), at(21, 0));
        let k = sim.kinds();
        assert_eq!(
            k,
            [
                ("28 17:40".to_owned(), ReminderKind::Stop),
                ("28 18:40".to_owned(), ReminderKind::StillTracking),
                ("28 19:40".to_owned(), ReminderKind::StillTracking),
                ("28 20:40".to_owned(), ReminderKind::StillTracking),
            ]
        );
        // The cadence follows the session past midnight.
        sim.run(at(21, 0), day(29, 2, 0));
        assert_eq!(sim.shown.len(), 9);
        assert_eq!(sim.kinds().last().unwrap().0, "29 01:40");
        // Stopping withdraws a pending one.
        sim.tracking = Tracking::Idle;
        assert_eq!(sim.at(day(29, 2, 0)), ReminderStep::Clear);
    }

    #[test]
    fn paused_gets_nothing_and_resuming_late_picks_up() {
        let mut sim = Sim::new();
        sim.ran_today = true;
        sim.tracking = active(at(9, 0));
        sim.run(at(9, 0), at(17, 0));
        // Paused across the stop time: nothing.
        sim.tracking = Tracking::Paused;
        sim.run(at(17, 0), at(19, 0));
        assert!(sim.shown.is_empty());
        // Resumed at 19:00: the stop reminder now, then hourly.
        sim.tracking = active(at(9, 0));
        sim.run(at(19, 0), at(20, 1));
        assert_eq!(
            sim.kinds(),
            [
                ("28 19:00".to_owned(), ReminderKind::Stop),
                ("28 20:00".to_owned(), ReminderKind::StillTracking)
            ]
        );
        // Pausing withdraws the pending reminder, and none comes while paused.
        sim.tracking = Tracking::Paused;
        assert_eq!(sim.at(at(20, 1)), ReminderStep::Clear);
        sim.run(at(20, 2), at(23, 0));
        assert_eq!(sim.shown.len(), 2);
    }

    #[test]
    fn a_session_started_after_hours_gets_hourly_checks_only() {
        let mut sim = Sim::new();
        sim.ran_today = true;
        sim.tracking = active(at(19, 0));
        sim.run(at(19, 0), at(21, 30));
        assert_eq!(
            sim.kinds(),
            [
                ("28 20:00".to_owned(), ReminderKind::StillTracking),
                ("28 21:00".to_owned(), ReminderKind::StillTracking)
            ]
        );
    }

    #[test]
    fn a_new_session_gets_its_own_cadence() {
        let mut sim = Sim::new();
        sim.ran_today = true;
        sim.tracking = active(at(9, 0));
        sim.run(at(9, 0), at(17, 45));
        assert_eq!(sim.shown.len(), 1);
        // Stopped at 17:45; another session at 18:30. The stop reminder was already
        // shown today and the old cadence does not carry over: the new session gets
        // hourly checks from its own start.
        sim.tracking = Tracking::Idle;
        assert_eq!(sim.at(at(17, 45)), ReminderStep::Clear);
        sim.tracking = Tracking::Active {
            session_id: Uuid::from_u128(8),
            started_at: at(18, 30),
        };
        sim.run(at(18, 30), at(20, 45));
        assert_eq!(
            sim.kinds(),
            [
                ("28 17:40".to_owned(), ReminderKind::Stop),
                ("28 19:30".to_owned(), ReminderKind::StillTracking),
                ("28 20:30".to_owned(), ReminderKind::StillTracking)
            ]
        );
    }

    #[test]
    fn switches_turn_each_reminder_off() {
        // Stop off: no stop reminder, but "still tracking?" follows on time.
        let mut sim = Sim::new();
        sim.settings.stop = false;
        sim.ran_today = true;
        sim.tracking = active(at(9, 0));
        sim.run(at(9, 0), at(19, 0));
        assert_eq!(
            sim.kinds(),
            [("28 18:40".to_owned(), ReminderKind::StillTracking)]
        );
        // Still-tracking off: only the stop reminder.
        let mut sim = Sim::new();
        sim.settings.still_tracking = false;
        sim.ran_today = true;
        sim.tracking = active(at(9, 0));
        sim.run(at(9, 0), at(23, 0));
        assert_eq!(sim.kinds(), [("28 17:40".to_owned(), ReminderKind::Stop)]);
        // Start off.
        let mut sim = Sim::new();
        sim.settings.start = false;
        sim.run(at(9, 0), at(17, 0));
        assert!(sim.shown.is_empty());
        // Master off: nothing, and a pending reminder is withdrawn.
        let mut sim = Sim::new();
        sim.run(at(9, 0), at(9, 11));
        sim.settings.enabled = false;
        assert_eq!(sim.at(at(9, 11)), ReminderStep::Clear);
        sim.tracking = active(at(9, 12));
        sim.run(at(9, 12), at(23, 0));
        assert_eq!(sim.shown.len(), 1);
    }

    #[test]
    fn day_off_and_weekend_have_no_reminders_but_own_hours_apply_without_a_schedule() {
        let mut sim = Sim::new();
        sim.schedule = Some(schedule(true, Some((8, 16)), Some(DayOff::Holiday)));
        sim.run(at(6, 0), at(12, 0));
        sim.ran_today = true;
        sim.tracking = active(at(12, 0));
        sim.run(at(12, 0), at(20, 0));
        assert!(sim.shown.is_empty(), "holiday");
        // Saturday with my hours.
        let mut sim = Sim::new();
        sim.run(day(31, 6, 0), day(31, 12, 0));
        assert!(sim.shown.is_empty(), "weekend");
        // Shift 08:00–16:00.
        let mut sim = Sim::new();
        sim.schedule = Some(schedule(true, Some((8, 16)), None));
        sim.run(at(6, 0), at(9, 0));
        assert_eq!(sim.kinds(), [("28 08:10".to_owned(), ReminderKind::Start)]);
        // Not scheduled: my hours.
        let mut sim = Sim::new();
        sim.schedule = Some(schedule(false, None, None));
        sim.run(at(6, 0), at(10, 0));
        assert_eq!(sim.kinds(), [("28 09:10".to_owned(), ReminderKind::Start)]);
    }

    #[test]
    fn ledger_dedupes_per_day_across_restarts() {
        let mut sim = Sim::new();
        sim.ran_today = true;
        sim.tracking = active(at(9, 0));
        sim.run(at(17, 0), at(17, 50));
        assert_eq!(sim.shown.len(), 1);
        // Restart: the ledger comes back from storage; nothing is repeated.
        let json = serde_json::to_string(&sim.ledger).unwrap();
        sim.ledger = serde_json::from_str(&json).unwrap();
        sim.pending = None;
        sim.run(at(17, 50), at(18, 39));
        assert_eq!(sim.shown.len(), 1);
        sim.run(at(18, 39), at(18, 41));
        assert_eq!(sim.shown.len(), 2, "the cadence survives the restart too");
        let empty: ReminderLedger = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, ReminderLedger::default());
    }

    #[test]
    fn choices_match_their_reminder() {
        assert!(ReminderChoice::Start.answers(ReminderKind::Start));
        assert!(ReminderChoice::NotToday.answers(ReminderKind::Start));
        assert!(!ReminderChoice::Stop.answers(ReminderKind::Start));
        assert!(ReminderChoice::Keep.answers(ReminderKind::StillTracking));
        assert!(ReminderChoice::Stop.answers(ReminderKind::Stop));
        assert!(!ReminderChoice::NotToday.answers(ReminderKind::Stop));
    }

    #[test]
    fn refresh_timing() {
        let m = Duration::from_secs;
        assert!(refresh_due(None, m(0), SCHEDULE_REFRESH));
        assert!(!refresh_due(Some(m(10)), m(3609), SCHEDULE_REFRESH));
        assert!(refresh_due(Some(m(10)), m(3610), SCHEDULE_REFRESH));
    }
}
