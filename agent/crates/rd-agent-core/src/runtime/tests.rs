use super::*;
use crate::api::LicenseBlock;
use crate::clock::{FakeClock, SystemClock};
use crate::events::{Envelope, StopReason};
use crate::outbox::{Outbox, StaticKey};
use crate::platform::{HttpResponse, InputSample};
use crate::policy::tests::{doc, pinned};
use crate::testing::{FakeCapturer, FakeForeground, FakeInput, FakeTransport, MemoryCredentials};
use chrono::TimeZone;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct RecordingSink(Arc<Mutex<Vec<ScreenshotJob>>>);

impl ScreenshotSink for RecordingSink {
    fn dispatch(&mut self, job: ScreenshotJob) {
        self.0.lock().unwrap().push(job);
    }
}

fn identity() -> DeviceIdentity {
    DeviceIdentity {
        server_url: "http://server.test".into(),
        device_id: "dev".into(),
        user_id: "user".into(),
        organization_id: "org".into(),
        policy_signing_key: pinned(),
        revoked: false,
        dashboard_url: None,
    }
}

fn shared_outbox() -> SharedOutbox {
    Arc::new(Mutex::new(
        Outbox::open_in_memory(&StaticKey([5; 32]), OutboxConfig::default()).unwrap(),
    ))
}

struct Harness {
    agent: Agent,
    clock: FakeClock,
    input: FakeInput,
    fg: FakeForeground,
    outbox: SharedOutbox,
    jobs: RecordingSink,
}

fn t0() -> DateTime<Utc> {
    // 09:00:30 so sessions start mid-minute.
    Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 30).unwrap()
}

fn harness_at(start: DateTime<Utc>, outbox: SharedOutbox, cfg: AgentConfig) -> Harness {
    let clock = FakeClock::new(start);
    let input = FakeInput::new();
    let fg = FakeForeground::new("com.example.editor");
    let jobs = RecordingSink::default();
    let agent = Agent::new(
        cfg,
        AgentDeps {
            clock: Arc::new(clock.clone()),
            input: Box::new(input.clone()),
            foreground: Box::new(fg.clone()),
            outbox: outbox.clone(),
            screenshots: Box::new(jobs.clone()),
            rng: StdRng::seed_from_u64(42),
        },
    )
    .unwrap();
    Harness {
        agent,
        clock,
        input,
        fg,
        outbox,
        jobs,
    }
}

fn harness() -> Harness {
    harness_at(t0(), shared_outbox(), AgentConfig::new(identity()))
}

impl Harness {
    fn step(&mut self, secs: u32) {
        for _ in 0..secs {
            self.clock.advance(Duration::from_secs(1));
            self.agent.tick();
        }
    }
    fn events(&self) -> Vec<Envelope> {
        lock(&self.outbox).peek_oldest(1_000_000).unwrap()
    }
    fn of_type(&self, t: &str) -> Vec<Envelope> {
        self.events()
            .into_iter()
            .filter(|e| e.body.event_type() == t)
            .collect()
    }
    fn tracked_seconds(&self) -> (u32, u32) {
        self.events()
            .iter()
            .fold((0, 0), |(a, i), e| match &e.body {
                EventBody::ActivityBucket(b) => (a + b.active_seconds, i + b.idle_seconds),
                _ => (a, i),
            })
    }
    fn jobs(&self) -> Vec<ScreenshotJob> {
        self.jobs.0.lock().unwrap().clone()
    }
}

fn types(events: &[Envelope]) -> Vec<&'static str> {
    events.iter().map(|e| e.body.event_type()).collect()
}

#[test]
fn session_produces_ordered_events_and_exact_tracked_time() {
    let mut h = harness();
    let id = h.agent.start(Some("p1".into()), None).unwrap();
    assert!(h.input.capturing());
    h.step(125);
    h.agent.stop(StopReason::User).unwrap();

    let evs = h.events();
    assert_eq!(evs.first().unwrap().body.event_type(), "session.started.v1");
    assert_eq!(evs.last().unwrap().body.event_type(), "session.stopped.v1");
    assert!(evs.windows(2).all(|w| w[0].sequence < w[1].sequence));
    assert!(evs
        .iter()
        .all(|e| e.session_id == id && e.device_id == "dev"));
    assert!(evs.iter().all(|e| e.event_id.get_version_num() == 4));

    let buckets: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.body {
            EventBody::ActivityBucket(b) => Some(b.clone()),
            _ => None,
        })
        .collect();
    let starts: Vec<_> = buckets
        .iter()
        .map(|b| b.bucket_start.format("%H:%M:%S").to_string())
        .collect();
    assert_eq!(starts, vec!["09:00:00", "09:01:00", "09:02:00"]);
    assert_eq!(buckets[0].active_seconds, 30);
    assert_eq!(h.tracked_seconds(), (125, 0));

    let app_secs: u32 = evs
        .iter()
        .filter_map(|e| match &e.body {
            EventBody::AppUsage(a) => Some(a.duration_seconds),
            _ => None,
        })
        .sum();
    assert_eq!(app_secs, 125);
    // monotonic_ms counts from session start.
    assert_eq!(evs.last().unwrap().monotonic_ms, 125_000);
    assert_eq!(evs[0].monotonic_ms, 0);
}

#[test]
fn nothing_is_captured_after_stop_not_even_within_one_tick() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(10);
    h.clock.advance(Duration::from_millis(400));
    h.agent.stop(StopReason::User).unwrap();
    let after_stop = h.events().len();
    let samples = h.input.samples_taken();
    assert!(!h.input.capturing());
    h.step(1);
    h.step(300);
    assert_eq!(h.events().len(), after_stop);
    assert_eq!(
        h.input.samples_taken(),
        samples,
        "no input sampled after stop"
    );
    assert!(h.jobs().is_empty());
    assert_eq!(h.tracked_seconds(), (10, 0));
}

#[test]
fn pause_captures_nothing_and_resume_continues() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(20); // 09:00:30 → 09:00:50
    h.agent.pause().unwrap();
    assert!(!h.input.capturing());
    let samples = h.input.samples_taken();
    h.step(600);
    assert_eq!(h.input.samples_taken(), samples);
    let during_pause: Vec<_> = types(&h.events()).into_iter().collect();
    // The parked 09:00 bucket is released once its minute is over; nothing else.
    assert_eq!(
        during_pause,
        vec![
            "session.started.v1",
            "app_usage.v1",
            "session.paused.v1",
            "activity_bucket.v1"
        ]
    );
    h.agent.resume().unwrap();
    h.step(30);
    h.agent.stop(StopReason::User).unwrap();
    assert_eq!(h.tracked_seconds(), (50, 0));
    let t = types(&h.events());
    assert!(t.contains(&"session.resumed.v1"));
}

#[test]
fn pause_and_resume_within_one_minute_never_duplicates_a_bucket() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(5); // 09:00:35
    h.agent.pause().unwrap();
    h.step(10); // 09:00:45
    h.agent.resume().unwrap();
    h.step(30); // 09:01:15
    h.agent.stop(StopReason::User).unwrap();
    let starts: Vec<_> = h
        .of_type("activity_bucket.v1")
        .iter()
        .map(|e| match &e.body {
            EventBody::ActivityBucket(b) => b.bucket_start,
            _ => unreachable!(),
        })
        .collect();
    let mut dedup = starts.clone();
    dedup.dedup();
    assert_eq!(starts, dedup);
    assert_eq!(starts.len(), 2);
    assert_eq!(h.tracked_seconds(), (35, 0));
}

#[test]
fn two_hour_suspend_yields_one_gap_and_no_tracked_time() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(30); // 09:01:00
    let gap_start = h.clock.wall();
    h.clock.advance(Duration::from_secs(7200));
    h.agent.tick();
    let gap_end = h.clock.wall();
    h.step(30);
    h.agent.stop(StopReason::User).unwrap();

    let gaps = h.of_type("data_gap.v1");
    assert_eq!(gaps.len(), 1);
    match &gaps[0].body {
        EventBody::DataGap(g) => {
            assert_eq!(g.reason, GapReason::Suspended);
            assert_eq!(g.gap_start, gap_start);
            assert_eq!(g.gap_end, gap_end);
        }
        _ => unreachable!(),
    }
    assert_eq!(
        h.tracked_seconds(),
        (60, 0),
        "the 2 h of sleep contribute nothing"
    );
    for e in h.of_type("activity_bucket.v1") {
        if let EventBody::ActivityBucket(b) = &e.body {
            assert!(
                b.bucket_start < gap_start || b.bucket_start >= crate::ts::floor_minute(gap_end),
                "no bucket inside the gap"
            );
        }
    }
    assert_eq!(h.agent.state(), SessionState::Stopped(StopReason::User));
}

#[test]
fn clock_change_emits_gap_without_losing_session() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(10);
    h.clock.advance(Duration::from_secs(1));
    h.clock.jump_wall(TimeDelta::hours(1));
    h.agent.tick();
    h.step(10);
    h.agent.stop(StopReason::User).unwrap();
    let gaps = h.of_type("data_gap.v1");
    assert_eq!(gaps.len(), 1);
    assert!(matches!(
        &gaps[0].body,
        EventBody::DataGap(DataGap {
            reason: GapReason::ClockChange,
            ..
        })
    ));
    assert_eq!(h.tracked_seconds(), (20, 0));
}

#[test]
fn idle_threshold_from_policy_and_attribution_back_to_run_start() {
    let mut h = harness();
    h.agent.on_policy(
        None,
        &doc(None, 5, json!({"idle": {"threshold_seconds": 60}})),
    );
    h.agent.start(None, None).unwrap();
    h.step(30); // active to 09:01:00
    let mut since = 0.0;
    h.input.idle(0.0);
    for _ in 0..120 {
        since += 1.0;
        h.input.idle(since);
        h.step(1);
    }
    h.agent.stop(StopReason::User).unwrap();
    assert_eq!(h.tracked_seconds(), (30, 120));
    let evs = h.events();
    assert!(evs.iter().all(|e| e.policy_version == 5));
}

#[test]
fn work_hours_pause_and_resume_automatically() {
    let start = Utc.with_ymd_and_hms(2026, 10, 28, 16, 59, 0).unwrap();
    let mut h = harness_at(start, shared_outbox(), AgentConfig::new(identity()));
    h.agent.on_policy(
        None,
        &doc(None, 2, json!({"work_hours": {"timezone": "UTC", "days": [], "start": "09:00", "end": "17:00"}})),
    );
    h.agent.start(None, None).unwrap();
    h.step(120);
    assert_eq!(
        h.agent.state(),
        SessionState::Paused(PauseReason::WorkHours)
    );
    assert_eq!(h.tracked_seconds(), (60, 0));
    let paused = h.of_type("session.paused.v1");
    assert_eq!(paused.len(), 1);
    assert_eq!(
        paused[0].occurred_at,
        Utc.with_ymd_and_hms(2026, 10, 28, 17, 0, 0).unwrap()
    );
    // Next morning.
    h.clock.advance(Duration::from_secs(16 * 3600 - 60));
    h.agent.tick();
    assert_eq!(h.agent.state(), SessionState::Active);
    h.step(10);
    h.agent.stop(StopReason::User).unwrap();
    assert_eq!(h.tracked_seconds(), (70, 0));
    assert_eq!(h.of_type("session.resumed.v1").len(), 1);
    assert!(
        h.of_type("data_gap.v1").is_empty(),
        "paused time is not a gap"
    );
}

#[test]
fn starting_outside_work_hours_pauses_immediately() {
    let start = Utc.with_ymd_and_hms(2026, 10, 28, 20, 0, 0).unwrap();
    let mut h = harness_at(start, shared_outbox(), AgentConfig::new(identity()));
    h.agent.on_policy(
        None,
        &doc(
            None,
            2,
            json!({"work_hours": {"timezone": "UTC", "start": "09:00", "end": "17:00"}}),
        ),
    );
    h.agent.start(None, None).unwrap();
    assert_eq!(
        h.agent.state(),
        SessionState::Paused(PauseReason::WorkHours)
    );
    h.step(60);
    assert_eq!(h.tracked_seconds(), (0, 0));
    assert_eq!(h.agent.take_notices(), vec![Notice::OutsideWorkHours]);
}

fn screenshot_policy(h: &mut Harness, project: &str, extra: Value) {
    let mut shots = json!({"enabled": true, "interval_minutes": 10});
    if let (Some(a), Some(b)) = (shots.as_object_mut(), extra.as_object()) {
        a.extend(b.clone());
    }
    h.agent.on_policy(
        Some(project),
        &doc(Some(project), 9, json!({"screenshots": shots})),
    );
}

#[test]
fn screenshots_one_per_interval_never_while_paused_and_cancelled_on_stop() {
    let mut h = harness();
    screenshot_policy(&mut h, "p1", json!({}));
    h.agent.start(Some("p1".into()), None).unwrap();
    assert!(h.agent.status().screenshots_enabled);
    h.step(3600);
    let n = h.jobs().len();
    assert!((5..=6).contains(&n), "one per 10-minute window, got {n}");
    assert!(h
        .jobs()
        .iter()
        .all(|j| j.max_width == 1280 && j.primary_monitor_only));

    h.agent.pause().unwrap();
    assert!(
        h.jobs().iter().all(|j| !j.gate.is_open()),
        "pause closes gates"
    );
    h.step(3600);
    assert_eq!(h.jobs().len(), n, "no screenshots while paused");

    h.agent.resume().unwrap();
    h.step(1200);
    let after_resume = h.jobs().len();
    assert!(after_resume > n);
    let open: Vec<_> = h.jobs().into_iter().filter(|j| j.gate.is_open()).collect();
    h.agent.stop(StopReason::User).unwrap();
    assert!(
        open.iter().all(|j| !j.gate.is_open()),
        "stop cancels in-flight jobs"
    );
    h.step(3600);
    assert_eq!(h.jobs().len(), after_resume);
}

#[test]
fn screenshots_respect_offline_excluded_apps_and_base_fallback() {
    let mut h = harness();
    screenshot_policy(
        &mut h,
        "p1",
        json!({"excluded_apps": ["com.example.editor"]}),
    );
    h.agent.start(Some("p1".into()), None).unwrap();
    h.step(1800);
    assert!(h.jobs().is_empty(), "excluded app was in the foreground");
    h.fg.set(Some("com.example.browser"));
    h.agent.set_online(false);
    h.step(1800);
    assert!(h.jobs().is_empty(), "never offline");
    h.agent.stop(StopReason::User).unwrap();

    // Base policy enables screenshots, but project p2 has no document of its own.
    let mut h = harness();
    h.agent.on_policy(
        None,
        &doc(
            None,
            3,
            json!({"screenshots": {"enabled": true, "interval_minutes": 10}}),
        ),
    );
    h.agent.start(Some("p2".into()), None).unwrap();
    assert_eq!(
        h.agent.effective_policy().source,
        PolicySource::BaseFallback
    );
    h.step(3600);
    assert!(h.jobs().is_empty());
    assert!(h.agent.take_policy_requests().contains(&Some("p2".into())));
}

#[test]
fn disabling_screenshots_mid_session_cancels_pending_jobs() {
    let mut h = harness();
    screenshot_policy(&mut h, "p1", json!({}));
    h.agent.start(Some("p1".into()), None).unwrap();
    h.step(600);
    let jobs = h.jobs();
    assert!(!jobs.is_empty());
    h.agent.on_policy(
        Some("p1"),
        &doc(Some("p1"), 10, json!({"screenshots": {"enabled": false}})),
    );
    assert!(jobs.iter().all(|j| !j.gate.is_open()));
    h.step(3600);
    assert_eq!(h.jobs().len(), jobs.len());
}

#[test]
fn overlap_rejection_stops_local_session() {
    let mut h = harness();
    let id = h.agent.start(None, None).unwrap();
    h.step(5);
    h.agent.on_sessions_rejected(&[Uuid::new_v4()]);
    assert_eq!(
        h.agent.state(),
        SessionState::Active,
        "other sessions are ignored"
    );
    h.agent.on_sessions_rejected(&[id]);
    assert_eq!(h.agent.state(), SessionState::Stopped(StopReason::Overlap));
    let stopped = h.of_type("session.stopped.v1");
    assert!(matches!(
        &stopped[0].body,
        EventBody::SessionStopped(SessionStopped {
            reason: StopReason::Overlap
        })
    ));
    assert!(h
        .agent
        .take_notices()
        .contains(&Notice::SessionOverlap { session_id: id }));
    let n = h.events().len();
    h.step(30);
    assert_eq!(h.events().len(), n);
}

#[test]
fn revocation_stops_capture_wipes_outbox_and_blocks_restart() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(90);
    assert!(!h.events().is_empty());
    h.agent.on_revoked();
    assert!(h.events().is_empty());
    assert!(!h.input.capturing());
    assert_eq!(h.agent.state(), SessionState::Stopped(StopReason::Revoked));
    h.step(60);
    assert!(h.events().is_empty());
    assert!(matches!(
        h.agent.start(None, None),
        Err(AgentError::Revoked)
    ));
}

#[test]
fn require_project_policy_is_enforced() {
    let mut h = harness();
    h.agent.on_policy(
        None,
        &doc(None, 1, json!({"session": {"require_project": true}})),
    );
    assert!(matches!(
        h.agent.start(None, None),
        Err(AgentError::ProjectRequired)
    ));
    assert!(h.agent.start(Some("p".into()), None).is_ok());
}

#[test]
fn app_usage_disabled_by_policy() {
    let mut h = harness();
    h.agent.on_policy(
        None,
        &doc(None, 1, json!({"apps": {"capture_app_name": false}})),
    );
    h.agent.start(None, None).unwrap();
    h.step(400);
    h.agent.stop(StopReason::User).unwrap();
    assert!(h.of_type("app_usage.v1").is_empty());
    assert!(!h.of_type("activity_bucket.v1").is_empty());
}

#[test]
fn permission_missing_buckets() {
    let mut h = harness();
    h.input.set(InputSample::default());
    h.agent.start(None, None).unwrap();
    h.step(90);
    h.agent.stop(StopReason::User).unwrap();
    let qualities: Vec<_> = h
        .of_type("activity_bucket.v1")
        .iter()
        .map(|e| match &e.body {
            EventBody::ActivityBucket(b) => b.data_quality,
            _ => unreachable!(),
        })
        .collect();
    assert!(qualities
        .iter()
        .all(|q| *q == crate::events::DataQuality::PermissionMissing));
    assert_eq!(h.tracked_seconds(), (0, 0));
}

#[test]
fn crash_recovery_resumes_recent_session_with_gap_and_keeps_sequence() {
    let outbox = shared_outbox();
    let mut h = harness_at(t0(), outbox.clone(), AgentConfig::new(identity()));
    let id = h.agent.start(None, None).unwrap();
    h.step(20);
    let last_seq = lock(&outbox).last_sequence().unwrap();
    let crashed_at = h.clock.wall();
    drop(h);

    let mut h = harness_at(
        crashed_at + TimeDelta::seconds(120),
        outbox,
        AgentConfig::new(identity()),
    );
    assert_eq!(h.agent.state(), SessionState::Active);
    assert_eq!(h.agent.session().unwrap().id, id);
    let gaps = h.of_type("data_gap.v1");
    assert_eq!(gaps.len(), 1);
    match &gaps[0].body {
        EventBody::DataGap(g) => {
            assert_eq!(g.reason, GapReason::OfflineAgentStopped);
            assert_eq!(g.gap_start, crashed_at);
        }
        _ => unreachable!(),
    }
    assert!(gaps[0].sequence > last_seq);
    h.step(10);
    h.agent.stop(StopReason::User).unwrap();
    assert!(h.events().iter().all(|e| e.session_id == id));
    assert!(h.events().windows(2).all(|w| w[0].sequence < w[1].sequence));
}

#[test]
fn crash_recovery_closes_stale_session_at_last_seen() {
    let outbox = shared_outbox();
    let mut h = harness_at(t0(), outbox.clone(), AgentConfig::new(identity()));
    let id = h.agent.start(None, None).unwrap();
    h.step(20); // snapshot persisted at tick 10 and 20
    let last_seen = h.clock.wall();
    drop(h);

    let h = harness_at(
        last_seen + TimeDelta::hours(14),
        outbox,
        AgentConfig::new(identity()),
    );
    assert_eq!(h.agent.state(), SessionState::Idle);
    let stopped = h.of_type("session.stopped.v1");
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0].session_id, id);
    assert_eq!(stopped[0].occurred_at, last_seen);
    assert_eq!(stopped[0].monotonic_ms, 20_000);
    assert!(lock(&h.outbox).get_meta(META_SESSION).unwrap().is_none());
}

#[test]
fn status_snapshot_is_persisted() {
    let mut h = harness();
    h.agent.start(Some("p9".into()), None).unwrap();
    h.step(5);
    let st = stored_status(&h.outbox).unwrap();
    let a = st.agent.unwrap();
    assert_eq!(a.state, "active");
    assert_eq!(a.project_id.as_deref(), Some("p9"));
    assert_eq!(a.policy_source, "defaults");
    assert!(st.outbox_depth > 0);
}

// ----- threaded runtime against a fake server ------------------------------------

fn fake_server(t: &FakeTransport, revoke_ingestion: bool) {
    t.set_handler(move |req| {
        let ok = |v: Value| Some(Ok(HttpResponse { status: 200, body: serde_json::to_vec(&v).unwrap() }));
        if req.url.contains("/v1/ingestion/event-batches") {
            if revoke_ingestion {
                return Some(Ok(HttpResponse {
                    status: 401,
                    body: br#"{"error":{"code":"device_revoked","message":"revoked"}}"#.to_vec(),
                }));
            }
            let v: Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
            let results: Vec<Value> = v["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| json!({"event_id": e["event_id"], "status": "accepted"}))
                .collect();
            return ok(json!({"server_time": "2026-10-28T09:00:00Z", "results": results}));
        }
        if req.url.contains("/v1/device/heartbeat") {
            return ok(json!({"server_time": "2026-10-28T09:00:00Z", "policy_revision": 0, "credential_status": "active"}));
        }
        if req.url.contains("/v1/device/policy") {
            let p = if req.url.contains("project_id=p1") { Some("p1") } else { None };
            let signed = doc(p, 1, json!({"idle": {"threshold_seconds": 120}}));
            return ok(serde_json::to_value(signed).unwrap());
        }
        None
    });
}

fn runtime(
    t: Arc<FakeTransport>,
    creds: Arc<MemoryCredentials>,
    outbox: SharedOutbox,
) -> (Runtime, AgentHandle) {
    let mut cfg = AgentConfig::new(identity());
    cfg.tick = Duration::from_millis(50);
    Runtime::new(
        cfg,
        RuntimeDeps {
            clock: Arc::new(SystemClock::new()),
            input: Box::new(FakeInput::new()),
            foreground: Box::new(FakeForeground::new("app")),
            capturer: FakeCapturer::new(64, 32),
            transport: t,
            credentials: creds,
            outbox,
            device_credential: "cred".into(),
            seed: Some(1),
        },
    )
    .unwrap()
}

fn fast_opts() -> RunOptions {
    RunOptions {
        auto_start: Some((Some("p1".into()), None)),
        max_duration: Some(Duration::from_millis(1500)),
        final_sync_timeout: Duration::from_secs(5),
        sync_interval: Duration::from_millis(200),
        heartbeat_interval: Duration::from_millis(300),
        policy_interval: Duration::from_secs(60),
        license_retry_interval: Duration::from_secs(900),
    }
}

#[test]
fn runtime_runs_syncs_and_shuts_down_cleanly() {
    let t = FakeTransport::new();
    fake_server(&t, false);
    let creds = Arc::new(MemoryCredentials::default());
    let outbox = shared_outbox();
    let (rt, _handle) = runtime(t.clone(), creds, outbox.clone());
    let summary = rt.run(fast_opts()).unwrap();
    assert!(!summary.revoked);
    assert_eq!(summary.outbox_depth, 0);
    let sent: Vec<String> = t
        .requests_to("/v1/ingestion/event-batches")
        .iter()
        .flat_map(|r| {
            let v: Value = serde_json::from_slice(r.body.as_ref().unwrap()).unwrap();
            v["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["event_type"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(sent.first().map(String::as_str), Some("session.started.v1"));
    assert_eq!(sent.last().map(String::as_str), Some("session.stopped.v1"));
    assert!(!t.requests_to("/v1/device/heartbeat").is_empty());
    assert!(!t.requests_to("/v1/device/policy?project_id=p1").is_empty());
    let st = stored_status(&outbox).unwrap();
    assert!(st.sync.unwrap().last_success_at.is_some());
}

#[test]
fn runtime_stop_command_is_applied_immediately() {
    let t = FakeTransport::new();
    fake_server(&t, false);
    let mut opts = fast_opts();
    opts.max_duration = Some(Duration::from_secs(30));
    // The runtime is deliberately not `Send` (native collectors may be thread-bound),
    // so build it on the thread that runs it and hand the handle back.
    let (htx, hrx) = mpsc::channel();
    let th = std::thread::spawn(move || {
        let (rt, handle) = runtime(t, Arc::new(MemoryCredentials::default()), shared_outbox());
        htx.send(handle).unwrap();
        rt.run(opts)
    });
    let handle = hrx.recv().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let sent_at = std::time::Instant::now();
    assert!(handle.send(Command::Shutdown(StopReason::User)));
    let summary = th.join().unwrap().unwrap();
    assert!(sent_at.elapsed() < Duration::from_secs(5));
    assert_eq!(summary.outbox_depth, 0);
}

#[test]
fn runtime_revocation_wipes_credential_and_outbox() {
    let t = FakeTransport::new();
    fake_server(&t, true);
    let creds = Arc::new(MemoryCredentials::default());
    creds.set(secret_names::DEVICE_CREDENTIAL, b"cred").unwrap();
    creds.set(secret_names::OUTBOX_KEY, &[1; 32]).unwrap();
    let outbox = shared_outbox();
    let (rt, _h) = runtime(t, creds.clone(), outbox.clone());
    let mut opts = fast_opts();
    opts.max_duration = Some(Duration::from_secs(30));
    let summary = rt.run(opts).unwrap();
    assert!(summary.revoked);
    assert_eq!(summary.outbox_depth, 0);
    assert!(creds
        .get(secret_names::DEVICE_CREDENTIAL)
        .unwrap()
        .is_none());
    assert!(creds.get(secret_names::OUTBOX_KEY).unwrap().is_none());
}

// ----- licensing (subscription_inactive / seat_unavailable) ------------------------

#[test]
fn license_block_soft_stops_session_keeps_outbox_and_refuses_new_sessions() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(45);
    h.agent
        .on_license_blocked(LicenseBlock::SubscriptionInactive);
    assert_eq!(h.agent.state(), SessionState::Stopped(StopReason::Policy));
    assert!(!h.input.capturing());
    let stopped = h.of_type("session.stopped.v1");
    assert!(matches!(
        &stopped[0].body,
        EventBody::SessionStopped(SessionStopped {
            reason: StopReason::Policy
        })
    ));
    let n = h.events().len();
    assert!(n > 2, "outbox is kept, not wiped");
    assert_eq!(
        h.tracked_seconds(),
        (45, 0),
        "buckets up to the stop are kept"
    );
    let samples = h.input.samples_taken();
    h.step(120);
    assert_eq!(h.events().len(), n, "nothing is collected while blocked");
    assert_eq!(h.input.samples_taken(), samples);
    assert!(matches!(
        h.agent.start(None, None),
        Err(AgentError::LicenseUnavailable(
            LicenseBlock::SubscriptionInactive
        ))
    ));
    assert!(h
        .agent
        .take_notices()
        .contains(&Notice::LicenseUnavailable {
            block: LicenseBlock::SubscriptionInactive
        }));
    let st = h.agent.status();
    assert_eq!(
        st.tracking_unavailable,
        Some(LicenseBlock::SubscriptionInactive)
    );
    assert_eq!(
        st.tracking_unavailable_message.as_deref(),
        Some("Tracking is unavailable: your organization's subscription is inactive")
    );
    // Persisted for `rd-agent status`.
    let stored = stored_status(&h.outbox).unwrap().agent.unwrap();
    assert_eq!(
        stored.tracking_unavailable,
        Some(LicenseBlock::SubscriptionInactive)
    );

    h.agent.on_license_restored();
    assert!(h.agent.take_notices().contains(&Notice::LicenseRestored));
    assert!(h.agent.status().tracking_unavailable.is_none());
    h.agent.start(None, None).unwrap();
    h.step(5);
    assert!(h.events().len() > n);
}

#[test]
fn license_block_while_paused_and_seat_message() {
    let mut h = harness();
    h.agent.start(None, None).unwrap();
    h.step(5);
    h.agent.pause().unwrap();
    h.agent.on_license_blocked(LicenseBlock::SeatUnavailable);
    assert_eq!(h.agent.state(), SessionState::Stopped(StopReason::Policy));
    assert!(matches!(
        h.agent.resume(),
        Err(AgentError::LicenseUnavailable(_))
    ));
    assert_eq!(
        h.agent.status().tracking_unavailable_message.as_deref(),
        Some("Tracking is unavailable: no licence seat assigned")
    );
    // A second refusal is idempotent (no duplicate stop, no duplicate notice).
    let n = h.events().len();
    h.agent.take_notices();
    h.agent.on_license_blocked(LicenseBlock::SeatUnavailable);
    assert_eq!(h.events().len(), n);
    assert!(h.agent.take_notices().is_empty());
}

#[test]
fn license_block_survives_restart_and_stops_recovered_session() {
    let outbox = shared_outbox();
    let mut h = harness_at(t0(), outbox.clone(), AgentConfig::new(identity()));
    h.agent.start(None, None).unwrap();
    h.step(20);
    // The agent dies with the session open, and the licence refusal was recorded (e.g.
    // by a later run that crashed): the next start must close the session, not resume.
    drop(h);
    lock(&outbox)
        .set_meta(META_LICENSE_BLOCK, "\"seat_unavailable\"")
        .unwrap();
    let h = harness_at(
        t0() + TimeDelta::seconds(60),
        outbox,
        AgentConfig::new(identity()),
    );
    assert_eq!(h.agent.license_block(), Some(LicenseBlock::SeatUnavailable));
    assert!(
        !h.agent.machine.is_open(),
        "a recovered session is not resumed while blocked"
    );
    assert!(!h.input.capturing());
    let last = h.events().last().cloned().unwrap();
    assert!(matches!(
        last.body,
        EventBody::SessionStopped(SessionStopped {
            reason: StopReason::Policy
        })
    ));
}

#[test]
fn license_info_is_exposed_in_status() {
    let mut h = harness();
    let info = crate::api::LicenseInfo {
        status: crate::api::LicenseStatus::Grace,
        grace_ends_at: crate::ts::parse("2026-11-01T00:00:00Z"),
    };
    h.agent.on_license_info(Some(info.clone()));
    assert_eq!(h.agent.status().license, Some(info.clone()));
    assert_eq!(
        stored_status(&h.outbox).unwrap().agent.unwrap().license,
        Some(info)
    );
}

/// A server that refuses everything with `403 subscription_inactive` until `open` is set.
fn licensing_server(t: &FakeTransport, open: Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::Ordering;
    t.set_handler(move |req| {
        let ok = |v: Value| Some(Ok(HttpResponse { status: 200, body: serde_json::to_vec(&v).unwrap() }));
        if !open.load(Ordering::SeqCst) {
            return Some(Ok(HttpResponse {
                status: 403,
                body: br#"{"error":{"code":"subscription_inactive","message":"lapsed","request_id":"r"}}"#.to_vec(),
            }));
        }
        if req.url.contains("/v1/ingestion/event-batches") {
            let v: Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
            let results: Vec<Value> = v["events"].as_array().unwrap().iter()
                .map(|e| json!({"event_id": e["event_id"], "status": "accepted"}))
                .collect();
            return ok(json!({"results": results}));
        }
        if req.url.contains("/v1/device/heartbeat") {
            return ok(json!({"policy_revision": 0, "credential_status": "active",
                             "license": {"status": "active"}}));
        }
        if req.url.contains("/v1/device/policy") {
            let p = if req.url.contains("project_id=p1") { Some("p1") } else { None };
            return ok(serde_json::to_value(doc(p, 1, json!({}))).unwrap());
        }
        None
    });
}

#[test]
fn runtime_license_refusal_soft_stops_and_throttles_heartbeats() {
    let t = FakeTransport::new();
    let open = Arc::new(std::sync::atomic::AtomicBool::new(false));
    licensing_server(&t, open);
    let creds = Arc::new(MemoryCredentials::default());
    creds.set(secret_names::DEVICE_CREDENTIAL, b"cred").unwrap();
    let outbox = shared_outbox();
    let (rt, _h) = runtime(t.clone(), creds.clone(), outbox.clone());
    let mut opts = fast_opts();
    opts.max_duration = Some(Duration::from_millis(1500));
    let summary = rt.run(opts).unwrap();
    assert!(!summary.revoked);
    assert_eq!(
        summary.license_block,
        Some(LicenseBlock::SubscriptionInactive)
    );
    assert!(
        creds
            .get(secret_names::DEVICE_CREDENTIAL)
            .unwrap()
            .is_some(),
        "credential kept"
    );
    let queued = lock(&outbox).peek_oldest(1000).unwrap();
    assert!(types(&queued).contains(&"session.started.v1"));
    assert!(queued.iter().any(|e| matches!(
        e.body,
        EventBody::SessionStopped(SessionStopped {
            reason: StopReason::Policy
        })
    )));
    // The first refused request (policy fetch, heartbeat or batch) blocks everything:
    // no further ingestion, no final sync, and no heartbeat retry within 15 minutes.
    assert!(t.requests_to("/v1/ingestion/event-batches").len() <= 1);
    assert!(t.requests_to("/v1/device/heartbeat").len() <= 1);
    assert!(
        t.requests().len() <= 3,
        "{} requests while blocked",
        t.requests().len()
    );
    let st = stored_status(&outbox).unwrap();
    assert_eq!(
        st.agent.unwrap().tracking_unavailable,
        Some(LicenseBlock::SubscriptionInactive)
    );
}

#[test]
fn runtime_resumes_after_heartbeat_succeeds_again() {
    use std::sync::atomic::Ordering;
    let t = FakeTransport::new();
    let open = Arc::new(std::sync::atomic::AtomicBool::new(false));
    licensing_server(&t, open.clone());
    let outbox = shared_outbox();
    let (rt, _h) = runtime(
        t.clone(),
        Arc::new(MemoryCredentials::default()),
        outbox.clone(),
    );
    let mut opts = fast_opts();
    opts.max_duration = Some(Duration::from_millis(2500));
    opts.license_retry_interval = Duration::from_millis(400);
    let opener = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        open.store(true, Ordering::SeqCst);
    });
    let summary = rt.run(opts).unwrap();
    opener.join().unwrap();
    assert_eq!(summary.license_block, None);
    assert_eq!(
        summary.outbox_depth, 0,
        "queued events delivered after restore"
    );
    let sent: Vec<String> = t
        .requests_to("/v1/ingestion/event-batches")
        .iter()
        .filter_map(|r| serde_json::from_slice::<Value>(r.body.as_ref().unwrap()).ok())
        .flat_map(|v| v["events"].as_array().cloned().unwrap_or_default())
        .map(|e| e["event_type"].as_str().unwrap().to_owned())
        .collect();
    // Delivered: first session (started + stopped/policy) and the auto-restarted one.
    assert!(
        sent.iter().filter(|t| *t == "session.started.v1").count() >= 2,
        "{sent:?}"
    );
    // Heartbeats while blocked were throttled to the retry interval.
    let hb = t.requests_to("/v1/device/heartbeat").len();
    assert!(hb <= 8, "too many heartbeats: {hb}");
    let st = stored_status(&outbox).unwrap().agent.unwrap();
    assert!(st.tracking_unavailable.is_none());
    assert_eq!(
        st.license.unwrap().status,
        crate::api::LicenseStatus::Active
    );
}

#[test]
fn live_session_counts_only_active_time_and_today_sums_buckets() {
    let outbox = shared_outbox();
    let mut h = harness_at(t0(), outbox.clone(), AgentConfig::new(identity()));
    assert_eq!(h.agent.live_session(), None);
    h.agent.start(Some("p1".into()), Some("t1".into())).unwrap();
    h.step(125);
    h.agent.pause().unwrap();
    h.step(60);
    let live = h.agent.live_session().unwrap();
    assert_eq!(live.state, "paused");
    assert_eq!(live.paused_reason, Some(PauseReason::User));
    assert_eq!(live.tracked_seconds, 125);
    assert_eq!(live.task_id.as_deref(), Some("t1"));
    h.agent.resume().unwrap();
    h.step(10);
    assert_eq!(h.agent.live_session().unwrap().tracked_seconds, 135);
    h.agent.stop(StopReason::User).unwrap();
    assert_eq!(h.agent.live_session(), None);

    let (active, idle) = h.tracked_seconds();
    let today = h.agent.today();
    assert_eq!(today.tracked_seconds, u64::from(active + idle));
    assert_eq!(today.active_seconds, u64::from(active));
    assert_eq!(today.activity_percent(), Some(100));
    drop(h);
    // Survives a restart.
    let h = harness_at(
        t0() + TimeDelta::minutes(10),
        outbox,
        AgentConfig::new(identity()),
    );
    assert_eq!(h.agent.today().tracked_seconds, today.tracked_seconds);
}

#[test]
fn today_totals_reset_on_a_new_day_and_skip_permission_missing() {
    let d1 = chrono::NaiveDate::from_ymd_opt(2026, 10, 28).unwrap();
    let d2 = d1.succ_opt().unwrap();
    let bucket = |active, idle, q| ActivityBucket {
        bucket_start: t0(),
        active_seconds: active,
        idle_seconds: idle,
        keyboard_count: 0,
        mouse_count: 0,
        data_quality: q,
    };
    let mut t = TodayTotals::default();
    t.add(d1, &bucket(40, 20, DataQuality::Ok));
    t.add(d1, &bucket(10, 0, DataQuality::Partial));
    t.add(d1, &bucket(0, 30, DataQuality::PermissionMissing));
    assert_eq!(t.tracked_seconds, 100);
    assert_eq!((t.active_seconds, t.idle_seconds), (50, 20));
    assert_eq!(t.activity_percent(), Some(71));
    assert_eq!(t.for_date(d2).tracked_seconds, 0);
    t.add(d2, &bucket(5, 5, DataQuality::Ok));
    assert_eq!((t.date, t.tracked_seconds), (Some(d2), 10));
}

#[test]
fn policy_preview_reports_fallback_until_the_project_document_arrives() {
    let mut h = harness();
    let p = h.agent.policy_preview(Some("p9"));
    assert_eq!(p.source, "defaults");
    assert!(!p.settings.screenshots.enabled);
    let _ = h.agent.take_policy_requests();
    h.agent.request_policy(Some("p9".into()));
    assert_eq!(
        h.agent.take_policy_requests(),
        vec![None, Some("p9".to_owned())]
    );
    screenshot_policy(&mut h, "p9", json!({}));
    let p = h.agent.policy_preview(Some("p9"));
    assert_eq!(p.source, "exact");
    assert!(p.settings.screenshots.enabled);
    assert_eq!(p.settings.screenshots.interval_minutes, 10);
    // Previewing collects nothing and opens no session.
    assert_eq!(h.agent.state(), SessionState::Idle);
    assert!(h.events().is_empty());
}

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<(Vec<LiveStatus>, Vec<Notice>)>>);

impl RuntimeObserver for Recorder {
    fn status(&mut self, status: &LiveStatus) {
        self.0.lock().unwrap().0.push(status.clone());
    }
    fn notice(&mut self, notice: &Notice) {
        self.0.lock().unwrap().1.push(notice.clone());
    }
}

#[test]
fn runtime_publishes_live_status_and_previews_to_the_observer() {
    let t = FakeTransport::new();
    fake_server(&t, false);
    let rec = Recorder::default();
    let (rt, handle) = runtime(
        t.clone(),
        Arc::new(MemoryCredentials::default()),
        shared_outbox(),
    );
    let rt = rt.with_observer(Box::new(rec.clone()));
    handle.send(Command::Preview {
        project_id: Some("p1".into()),
    });
    let summary = rt.run(fast_opts()).unwrap();
    assert_eq!(summary.outbox_depth, 0);
    let (statuses, _) = rec.0.lock().unwrap().clone();
    assert!(statuses.len() > 10, "published every tick");
    assert!(statuses.iter().any(|s| s
        .session
        .as_ref()
        .is_some_and(|x| x.project_id.as_deref() == Some("p1"))));
    assert!(statuses.iter().any(|s| s
        .preview
        .as_ref()
        .is_some_and(|p| p.project_id.as_deref() == Some("p1")
            && p.source == "exact"
            && p.settings.idle.threshold_seconds == 120)));
    assert!(statuses.iter().any(|s| s.sync.last_success_at.is_some()));
    let last = statuses.last().unwrap();
    assert!(last.session.is_none(), "final snapshot after shutdown");
    assert_eq!(last.agent.state, "stopped");
    assert!(!last.revoked);
}

// ----- idle return prompt (Stage 4 F1) ---------------------------------------------

fn at(h: u32, m: u32, s: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 28, h, m, s).unwrap()
}

fn active_input() -> InputSample {
    InputSample {
        keyboard_count: 3,
        mouse_count: 5,
        counts_available: true,
        seconds_since_last_input: Some(0.1),
    }
}

/// Base policy revision 5 with a 60 s idle threshold plus `extra` idle settings.
fn idle_policy(h: &mut Harness, extra: Value) {
    let mut idle = json!({"threshold_seconds": 60});
    if let (Some(a), Some(b)) = (idle.as_object_mut(), extra.as_object()) {
        a.extend(b.clone());
    }
    h.agent
        .on_policy(None, &doc(None, 5, json!({ "idle": idle })));
}

/// `secs` seconds without input (the OS idle timer counting up).
fn away(h: &mut Harness, secs: u32) {
    for i in 1..=secs {
        h.input.idle(f64::from(i));
        h.step(1);
    }
}

/// `secs` seconds without input, then one second with input.
fn away_and_back(h: &mut Harness, secs: u32) {
    away(h, secs);
    h.input.set(active_input());
    h.step(1);
}

fn idle_returns(notices: &[Notice]) -> Vec<Notice> {
    notices
        .iter()
        .filter(|n| matches!(n, Notice::IdleReturn { .. }))
        .cloned()
        .collect()
}

fn decisions(h: &Harness) -> Vec<Envelope> {
    h.of_type("idle.decision.v1")
}

#[test]
fn idle_return_publishes_a_notice_and_one_pending_prompt() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    let session = h.agent.start(Some("p1".into()), Some("t1".into())).unwrap();
    h.step(30); // active to 09:01:00
    away_and_back(&mut h, 120); // idle 09:01:00–09:03:00, back at 09:03:00
    let notices = idle_returns(&h.agent.take_notices());
    let prompt = h.agent.idle_prompt().cloned().expect("a pending prompt");
    assert_eq!(
        notices,
        vec![Notice::IdleReturn {
            id: prompt.id,
            started_at: at(9, 1, 0),
            ended_at: at(9, 3, 0),
            seconds: 120,
            project_id: Some("p1".into()),
        }]
    );
    assert_eq!(prompt.session_id, session);
    assert_eq!(prompt.task_id.as_deref(), Some("t1"));
    // The notice serializes for the UI with RFC 3339 times.
    let v = serde_json::to_value(&notices[0]).unwrap();
    assert_eq!(v["kind"], "idle_return");
    assert_eq!(v["started_at"], "2026-10-28T09:01:00Z");
    assert_eq!(v["ended_at"], "2026-10-28T09:03:00Z");
    // Prompting sends nothing and changes nothing: tracking carries on.
    assert!(decisions(&h).is_empty());
    assert_eq!(h.agent.state(), SessionState::Active);
    h.step(10);
    assert!(h.agent.take_notices().is_empty(), "notified once");
    h.agent.stop(StopReason::User).unwrap();
    assert_eq!(h.tracked_seconds(), (30 + 1 + 10, 120));
}

#[test]
fn resolving_queues_the_exact_idle_decision_event_and_clears_the_prompt() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    let session = h.agent.start(Some("p1".into()), None).unwrap();
    h.step(30);
    away_and_back(&mut h, 120);
    h.step(5); // answered at 09:03:06
    let id = h.agent.idle_prompt().unwrap().id;
    let before = h.events().last().unwrap().sequence;
    assert!(h
        .agent
        .resolve_idle(id, IdleDecision::Discard, Some("ignored".into()), None)
        .unwrap());
    assert!(h.agent.idle_prompt().is_none(), "cleared once answered");
    let evs = decisions(&h);
    assert_eq!(evs.len(), 1);
    let e = &evs[0];
    assert!(e.sequence > before);
    assert_eq!(e.event_id.get_version_num(), 4);
    let mut v = serde_json::to_value(e).unwrap();
    let obj = v.as_object_mut().unwrap();
    obj.remove("event_id");
    obj.remove("sequence");
    assert_eq!(
        v,
        json!({
            "organization_id": "org",
            "device_id": "dev",
            "session_id": session.to_string(),
            "policy_version": 5,
            "event_type": "idle.decision.v1",
            "occurred_at": "2026-10-28T09:03:06Z",
            "monotonic_ms": 156_000,
            "payload": {
                "idle_started_at": "2026-10-28T09:01:00Z",
                "idle_ended_at": "2026-10-28T09:03:00Z",
                "decision": "discard"
            }
        })
    );
    // A second answer (double click, stale window) or an unknown id is ignored.
    assert!(!h
        .agent
        .resolve_idle(id, IdleDecision::Keep, None, None)
        .unwrap());
    assert!(!h
        .agent
        .resolve_idle(Uuid::new_v4(), IdleDecision::Keep, None, None)
        .unwrap());
    assert_eq!(decisions(&h).len(), 1);
    // Tracking carried on; the server, not the agent, removes the idle seconds.
    assert_eq!(h.agent.state(), SessionState::Active);
    h.agent.stop(StopReason::User).unwrap();
    assert_eq!(h.tracked_seconds(), (36, 120));
}

#[test]
fn reassign_needs_a_project_and_keep_sends_no_project() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    h.agent.start(Some("p1".into()), None).unwrap();
    h.step(30);
    away_and_back(&mut h, 90);
    let id = h.agent.idle_prompt().unwrap().id;
    assert!(matches!(
        h.agent
            .resolve_idle(id, IdleDecision::Reassign, None, Some("t9".into())),
        Err(AgentError::IdleProjectRequired)
    ));
    assert!(matches!(
        h.agent
            .resolve_idle(id, IdleDecision::Reassign, Some(String::new()), None),
        Err(AgentError::IdleProjectRequired)
    ));
    assert!(
        h.agent.idle_prompt().is_some(),
        "still pending after a refusal"
    );
    assert!(decisions(&h).is_empty());
    assert!(h
        .agent
        .resolve_idle(
            id,
            IdleDecision::Reassign,
            Some("p2".into()),
            Some("t9".into())
        )
        .unwrap());
    let v = serde_json::to_value(&decisions(&h)[0]).unwrap();
    assert_eq!(
        v["payload"],
        json!({
            "idle_started_at": "2026-10-28T09:01:00Z",
            "idle_ended_at": "2026-10-28T09:02:30Z",
            "decision": "reassign",
            "project_id": "p2",
            "task_id": "t9"
        })
    );

    away_and_back(&mut h, 90);
    let id = h.agent.idle_prompt().unwrap().id;
    h.agent
        .resolve_idle(id, IdleDecision::Keep, Some("p2".into()), Some("t9".into()))
        .unwrap();
    let v = serde_json::to_value(&decisions(&h)[1]).unwrap();
    assert_eq!(
        v["payload"],
        json!({
            "idle_started_at": "2026-10-28T09:02:31Z",
            "idle_ended_at": "2026-10-28T09:04:01Z",
            "decision": "keep"
        })
    );
}

#[test]
fn prompt_on_return_false_never_prompts_and_never_sends() {
    let mut h = harness();
    idle_policy(&mut h, json!({"prompt_on_return": false}));
    h.agent.start(None, None).unwrap();
    h.step(30);
    away_and_back(&mut h, 300);
    assert!(idle_returns(&h.agent.take_notices()).is_empty());
    assert!(h.agent.idle_prompt().is_none());
    h.agent.stop(StopReason::User).unwrap();
    assert!(decisions(&h).is_empty());
    // The idle time is kept, exactly as before F1.
    assert_eq!(h.tracked_seconds(), (31, 300));
}

#[test]
fn turning_prompts_off_drops_a_pending_prompt_as_keep() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    h.agent.start(None, None).unwrap();
    h.step(30);
    away_and_back(&mut h, 90);
    let id = h.agent.idle_prompt().unwrap().id;
    h.agent.on_policy(
        None,
        &doc(None, 6, json!({"idle": {"prompt_on_return": false}})),
    );
    assert!(h.agent.idle_prompt().is_none());
    assert!(!h
        .agent
        .resolve_idle(id, IdleDecision::Discard, None, None)
        .unwrap());
    assert!(decisions(&h).is_empty());
}

#[test]
fn a_newer_idle_run_replaces_an_unanswered_prompt_which_counts_as_keep() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    h.agent.start(None, None).unwrap();
    h.step(30);
    away_and_back(&mut h, 90); // 09:01:00–09:02:30
    let first = h.agent.idle_prompt().unwrap().id;
    h.step(10);
    away_and_back(&mut h, 75); // 09:02:41–09:03:56
    let second = h.agent.idle_prompt().cloned().unwrap();
    assert_ne!(second.id, first);
    assert_eq!(
        (second.started_at, second.ended_at, second.seconds),
        (at(9, 2, 41), at(9, 3, 56), 75)
    );
    assert_eq!(
        idle_returns(&h.agent.take_notices()).len(),
        2,
        "one notice per run"
    );
    // The replaced prompt can no longer be answered, and sent nothing.
    assert!(!h
        .agent
        .resolve_idle(first, IdleDecision::Discard, None, None)
        .unwrap());
    assert!(decisions(&h).is_empty());
    h.agent
        .resolve_idle(second.id, IdleDecision::Discard, None, None)
        .unwrap();
    let evs = decisions(&h);
    assert_eq!(evs.len(), 1);
    assert_eq!(
        serde_json::to_value(&evs[0]).unwrap()["payload"]["idle_started_at"],
        "2026-10-28T09:02:41Z"
    );
}

#[test]
fn pause_suspend_and_stop_during_an_idle_run_are_not_a_return() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    h.agent.start(None, None).unwrap();
    h.step(30);

    // Away, then paused (work hours, or the tray menu), then resumed with input.
    away(&mut h, 120);
    h.agent.pause().unwrap();
    h.step(30);
    h.input.set(active_input());
    h.agent.resume().unwrap();
    h.step(5);
    assert!(h.agent.idle_prompt().is_none(), "pause is not a return");

    // Away, then the machine sleeps for an hour and wakes with the person back.
    away(&mut h, 120);
    h.clock.advance(Duration::from_secs(3600));
    h.input.set(active_input());
    h.agent.tick();
    h.step(5);
    assert!(h.agent.idle_prompt().is_none(), "suspend is not a return");
    assert_eq!(h.of_type("data_gap.v1").len(), 1);

    // Away, then the wall clock jumps.
    away(&mut h, 120);
    h.clock.advance(Duration::from_secs(1));
    h.clock.jump_wall(TimeDelta::hours(1));
    h.input.set(active_input());
    h.agent.tick();
    h.step(5);
    assert!(
        h.agent.idle_prompt().is_none(),
        "a clock change is not a return"
    );

    // Away, then stopped.
    away(&mut h, 120);
    h.agent.stop(StopReason::User).unwrap();
    assert!(h.agent.idle_prompt().is_none(), "stop is not a return");
    assert!(idle_returns(&h.agent.take_notices()).is_empty());
    assert!(decisions(&h).is_empty());
}

#[test]
fn a_prompt_answered_after_stop_belongs_to_the_session_of_the_idle_run() {
    let mut h = harness();
    idle_policy(&mut h, json!({}));
    let first = h.agent.start(Some("p1".into()), None).unwrap();
    h.step(30);
    away_and_back(&mut h, 90);
    h.agent.stop(StopReason::User).unwrap();
    let second = h.agent.start(None, None).unwrap();
    h.step(3);
    let id = h.agent.idle_prompt().unwrap().id;
    h.agent
        .resolve_idle(id, IdleDecision::Discard, None, None)
        .unwrap();
    let evs = decisions(&h);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].session_id, first);
    assert_ne!(evs[0].session_id, second);
    // Milliseconds since the first session's start, on the same monotonic clock.
    assert_eq!(evs[0].monotonic_ms, (30 + 90 + 1 + 3) * 1000);
}

#[test]
fn spans_longer_than_twelve_hours_are_sent_in_pieces() {
    let start = at(20, 0, 0);
    let end = start + TimeDelta::hours(13) + TimeDelta::minutes(30);
    let p = idle_decision_payloads(start, end, IdleDecision::Reassign, Some("p2".into()), None);
    assert_eq!(p.len(), 2);
    assert_eq!(p[0].idle_started_at, start);
    assert_eq!(p[0].idle_ended_at, start + TimeDelta::hours(12));
    assert_eq!(p[1].idle_started_at, p[0].idle_ended_at);
    assert_eq!(p[1].idle_ended_at, end);
    assert!(p.iter().all(|x| x.project_id.as_deref() == Some("p2")));
    let exactly = idle_decision_payloads(
        start,
        start + TimeDelta::hours(12),
        IdleDecision::Keep,
        Some("x".into()),
        Some("y".into()),
    );
    assert_eq!(exactly.len(), 1);
    assert_eq!(
        (exactly[0].project_id.clone(), exactly[0].task_id.clone()),
        (None, None)
    );
    assert!(idle_decision_payloads(start, start, IdleDecision::Keep, None, None).is_empty());
}

#[test]
fn runtime_resolve_idle_command_queues_the_event_and_clears_live_status() {
    let clock = FakeClock::new(t0());
    let input = FakeInput::new();
    let outbox = shared_outbox();
    let (mut rt, _handle) = Runtime::new(
        AgentConfig::new(identity()),
        RuntimeDeps {
            clock: Arc::new(clock.clone()),
            input: Box::new(input.clone()),
            foreground: Box::new(FakeForeground::new("app")),
            capturer: FakeCapturer::new(64, 32),
            transport: FakeTransport::new(),
            credentials: Arc::new(MemoryCredentials::default()),
            outbox: outbox.clone(),
            device_credential: "cred".into(),
            seed: Some(1),
        },
    )
    .unwrap();
    rt.agent_mut().on_policy(
        None,
        &doc(None, 5, json!({"idle": {"threshold_seconds": 60}})),
    );
    let rec = Recorder::default();
    let mut rt = rt.with_observer(Box::new(rec.clone()));
    rt.handle_command(Command::Start {
        project_id: Some("p1".into()),
        task_id: None,
    });
    let tick = |rt: &mut Runtime, n: u32| {
        for _ in 0..n {
            clock.advance(Duration::from_secs(1));
            rt.agent.tick();
            rt.forward_agent_outputs();
        }
    };
    tick(&mut rt, 30);
    for i in 1..=90 {
        input.idle(f64::from(i));
        tick(&mut rt, 1);
    }
    input.set(active_input());
    tick(&mut rt, 1);
    let prompt = rt.live_status().idle_prompt.expect("published for the UI");
    assert_eq!(prompt.seconds, 90);
    assert_eq!(prompt.project_id.as_deref(), Some("p1"));
    assert!(rec
        .0
        .lock()
        .unwrap()
        .1
        .iter()
        .any(|n| matches!(n, Notice::IdleReturn { id, .. } if *id == prompt.id)));
    // Stale ids are ignored without touching the pending prompt.
    rt.handle_command(Command::ResolveIdle {
        id: Uuid::new_v4(),
        decision: IdleDecision::Discard,
        project_id: None,
        task_id: None,
    });
    assert!(rt.live_status().idle_prompt.is_some());
    rt.handle_command(Command::ResolveIdle {
        id: prompt.id,
        decision: IdleDecision::Keep,
        project_id: None,
        task_id: None,
    });
    let (statuses, _) = rec.0.lock().unwrap().clone();
    assert!(
        statuses.last().unwrap().idle_prompt.is_none(),
        "the published status clears the prompt"
    );
    let queued = lock(&outbox).peek_oldest(1000).unwrap();
    let ev: Vec<_> = queued
        .iter()
        .filter(|e| e.body.event_type() == "idle.decision.v1")
        .collect();
    assert_eq!(ev.len(), 1);
    assert_eq!(
        serde_json::to_value(ev[0]).unwrap()["payload"],
        json!({
            "idle_started_at": "2026-10-28T09:01:00Z",
            "idle_ended_at": "2026-10-28T09:02:30Z",
            "decision": "keep"
        })
    );
}
