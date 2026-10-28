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
    assert!(h.agent.take_notices().contains(&Notice::LicenseUnavailable(
        LicenseBlock::SubscriptionInactive
    )));
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
