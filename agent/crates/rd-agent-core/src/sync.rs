//! Outbox → server synchronisation (system design §8, "Outbox").
//!
//! * Sends the oldest events first, at most [`MAX_BATCH_EVENTS`] per batch and never more
//!   than [`MAX_BATCH_BYTES`] serialized (a batch that would be larger is split).
//! * Per-event results: `accepted` / `duplicate` → deleted; `rejected` → deleted and the
//!   reason recorded locally. A rejected `session.started.v1` with `overlapping_session`
//!   is reported so the runtime stops the local session. Events missing from the
//!   results (or with an unknown status) stay queued.
//! * Retryable failures (network, 5xx, 429) back off exponentially from 1 s to 5 min
//!   with jitter. A batch-level 400/413/422 is bisected so one poison event cannot block
//!   the queue forever.
//! * `401 device_revoked` is surfaced as [`SyncError::Revoked`].

use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use thiserror::Error;
use uuid::Uuid;

pub use crate::api::{MAX_BATCH_BYTES, MAX_BATCH_EVENTS};
use crate::api::{ApiClient, ApiError, EventBatchRequest, EventBatchResponse, EventStatus};
use crate::clock::Clock;
use crate::events::{Envelope, EventBody};
use crate::outbox::{lock, OutboxError, SharedOutbox};

/// Reason code that makes the agent stop its local session.
pub const OVERLAPPING_SESSION: &str = "overlapping_session";

/// Exponential backoff with jitter.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    failures: u32,
    retry_at: Option<Duration>,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(Duration::from_secs(1), Duration::from_secs(300))
    }
}

impl Backoff {
    /// Backoff from `base` doubling up to `max`.
    pub fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            failures: 0,
            retry_at: None,
        }
    }

    /// Consecutive failures so far.
    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Un-jittered delay after `failures` consecutive failures.
    pub fn nominal_delay(&self, failures: u32) -> Duration {
        let exp = failures.saturating_sub(1).min(20);
        self.base.saturating_mul(1u32 << exp).min(self.max)
    }

    /// Time left before the next attempt is allowed (zero when ready).
    pub fn remaining(&self, now_mono: Duration) -> Duration {
        self.retry_at
            .map(|t| t.saturating_sub(now_mono))
            .unwrap_or(Duration::ZERO)
    }

    /// `true` if an attempt is allowed at `now_mono`.
    pub fn ready(&self, now_mono: Duration) -> bool {
        self.remaining(now_mono).is_zero()
    }

    /// Records a failure; returns the (jittered) delay until the next attempt, which is
    /// uniformly distributed in `[nominal/2, nominal]`.
    pub fn failure(&mut self, now_mono: Duration, rng: &mut impl Rng) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let nominal = self.nominal_delay(self.failures);
        let ms = u64::try_from(nominal.as_millis()).unwrap_or(u64::MAX);
        let delay = Duration::from_millis(rng.gen_range(ms / 2..=ms));
        self.retry_at = Some(now_mono + delay);
        delay
    }

    /// Records a success (resets the backoff).
    pub fn success(&mut self) {
        self.failures = 0;
        self.retry_at = None;
    }
}

/// What one [`Syncer::sync`] call achieved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Batches sent.
    pub batches: usize,
    /// Events accepted.
    pub accepted: usize,
    /// Events already known to the server.
    pub duplicate: usize,
    /// Events rejected (deleted, reason recorded).
    pub rejected: usize,
    /// Sessions whose start was rejected as overlapping.
    pub overlapping_sessions: Vec<Uuid>,
    /// Events still queued afterwards.
    pub remaining: u64,
}

/// Why a sync did not complete.
#[derive(Debug, Error)]
pub enum SyncError {
    /// The device credential was revoked.
    #[error("device revoked")]
    Revoked,
    /// Backing off; no request was made.
    #[error("backing off for {0:?}")]
    BackingOff(Duration),
    /// A request failed; backoff has been scheduled. `partial` is what succeeded first.
    #[error("sync failed: {error}")]
    Failed {
        /// The failure.
        error: ApiError,
        /// Work completed before the failure.
        partial: SyncReport,
    },
    /// Local storage failed.
    #[error(transparent)]
    Outbox(#[from] OutboxError),
}

/// Drains the outbox to the server.
#[derive(Debug)]
pub struct Syncer {
    backoff: Backoff,
    rng: StdRng,
    max_batch: usize,
    max_bytes: usize,
    max_batches_per_sync: usize,
}

impl Default for Syncer {
    fn default() -> Self {
        Self::new(StdRng::from_entropy())
    }
}

enum Sent {
    Progress,
    NoProgress,
}

impl Syncer {
    /// A syncer with default limits.
    pub fn new(rng: StdRng) -> Self {
        Self {
            backoff: Backoff::default(),
            rng,
            max_batch: MAX_BATCH_EVENTS,
            max_bytes: MAX_BATCH_BYTES,
            max_batches_per_sync: 20,
        }
    }

    /// Overrides the batch size (≤ 500).
    pub fn with_max_batch(mut self, n: usize) -> Self {
        self.max_batch = n.clamp(1, MAX_BATCH_EVENTS);
        self
    }

    /// Overrides the serialized batch size limit (≤ 1 MiB).
    pub fn with_max_bytes(mut self, n: usize) -> Self {
        self.max_bytes = n.clamp(1, MAX_BATCH_BYTES);
        self
    }

    /// The backoff state.
    pub fn backoff(&self) -> &Backoff {
        &self.backoff
    }

    /// Sends queued events until the outbox is empty, a failure occurs, or the per-call
    /// batch budget is used.
    pub fn sync(
        &mut self,
        outbox: &SharedOutbox,
        api: &ApiClient,
        clock: &dyn Clock,
    ) -> Result<SyncReport, SyncError> {
        let now = clock.monotonic();
        if !self.backoff.ready(now) {
            return Err(SyncError::BackingOff(self.backoff.remaining(now)));
        }
        let mut report = SyncReport::default();
        for _ in 0..self.max_batches_per_sync {
            let events = lock(outbox).peek_oldest(self.max_batch)?;
            if events.is_empty() {
                break;
            }
            match self.send(outbox, api, events, &mut report) {
                Ok(Sent::Progress) => {}
                Ok(Sent::NoProgress) => {
                    let error = ApiError::Decode("server returned no usable results".into());
                    self.backoff.failure(clock.monotonic(), &mut self.rng);
                    return Err(SyncError::Failed {
                        error,
                        partial: report,
                    });
                }
                Err(SendError::Revoked) => return Err(SyncError::Revoked),
                Err(SendError::Outbox(e)) => return Err(SyncError::Outbox(e)),
                Err(SendError::Api(error)) => {
                    let delay = self.backoff.failure(clock.monotonic(), &mut self.rng);
                    log::info!("sync failed ({error}); retrying in {delay:?}");
                    return Err(SyncError::Failed {
                        error,
                        partial: report,
                    });
                }
            }
        }
        self.backoff.success();
        report.remaining = lock(outbox).depth()?;
        if report.batches > 0 {
            log::info!(
                "synced {} batch(es): {} accepted, {} duplicate, {} rejected, {} remaining",
                report.batches,
                report.accepted,
                report.duplicate,
                report.rejected,
                report.remaining
            );
        }
        Ok(report)
    }

    fn send(
        &mut self,
        outbox: &SharedOutbox,
        api: &ApiClient,
        events: Vec<Envelope>,
        report: &mut SyncReport,
    ) -> Result<Sent, SendError> {
        let req = EventBatchRequest {
            batch_id: Uuid::new_v4(),
            sent_at: crate::ts::to_millis(Utc::now()),
            events,
        };
        let body = ApiClient::encode_batch(&req).map_err(SendError::Api)?;
        if body.len() > self.max_bytes && req.events.len() > 1 {
            return self.split(outbox, api, req.events, report);
        }
        report.batches += 1;
        match api.send_batch_bytes(body) {
            Ok(resp) => apply_results(outbox, &req.events, &resp, report),
            Err(ApiError::DeviceRevoked) => Err(SendError::Revoked),
            Err(ApiError::Http { status, code }) if matches!(status, 400 | 413 | 422) => {
                if req.events.len() > 1 {
                    self.split(outbox, api, req.events, report)
                } else {
                    // A single event the server refuses as a batch: drop it, record why.
                    let ev = &req.events[0];
                    let reason = code.unwrap_or_else(|| format!("http_{status}"));
                    let mut o = lock(outbox);
                    o.delete(&[ev.event_id])?;
                    o.record_rejection(&ev.event_id.to_string(), ev.body.event_type(), &reason)?;
                    report.rejected += 1;
                    log::warn!("dropped one {} event refused by the server", ev.body.event_type());
                    Ok(Sent::Progress)
                }
            }
            Err(e) => Err(SendError::Api(e)),
        }
    }

    fn split(
        &mut self,
        outbox: &SharedOutbox,
        api: &ApiClient,
        mut events: Vec<Envelope>,
        report: &mut SyncReport,
    ) -> Result<Sent, SendError> {
        let second = events.split_off(events.len() / 2);
        let a = self.send(outbox, api, events, report)?;
        let b = self.send(outbox, api, second, report)?;
        Ok(match (a, b) {
            (Sent::NoProgress, Sent::NoProgress) => Sent::NoProgress,
            _ => Sent::Progress,
        })
    }
}

enum SendError {
    Revoked,
    Api(ApiError),
    Outbox(OutboxError),
}

impl From<OutboxError> for SendError {
    fn from(e: OutboxError) -> Self {
        SendError::Outbox(e)
    }
}

fn apply_results(
    outbox: &SharedOutbox,
    events: &[Envelope],
    resp: &EventBatchResponse,
    report: &mut SyncReport,
) -> Result<Sent, SendError> {
    let results: HashMap<Uuid, _> = resp.results.iter().map(|r| (r.event_id, r)).collect();
    let mut done = Vec::new();
    let mut o = lock(outbox);
    for ev in events {
        let Some(r) = results.get(&ev.event_id) else {
            continue;
        };
        match r.status {
            EventStatus::Accepted => {
                report.accepted += 1;
                done.push(ev.event_id);
            }
            EventStatus::Duplicate => {
                report.duplicate += 1;
                done.push(ev.event_id);
            }
            EventStatus::Rejected => {
                let reason = r.reason.as_deref().unwrap_or("unspecified");
                o.record_rejection(&ev.event_id.to_string(), ev.body.event_type(), reason)?;
                log::warn!("server rejected a {} event: {reason}", ev.body.event_type());
                if matches!(ev.body, EventBody::SessionStarted(_)) && reason == OVERLAPPING_SESSION
                {
                    report.overlapping_sessions.push(ev.session_id);
                }
                report.rejected += 1;
                done.push(ev.event_id);
            }
            EventStatus::Unknown => {}
        }
    }
    o.delete(&done)?;
    Ok(if done.is_empty() {
        Sent::NoProgress
    } else {
        Sent::Progress
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::events::{ActivityBucket, DataQuality, SessionStarted};
    use crate::outbox::{NewEvent, Outbox, OutboxConfig, StaticKey};
    use crate::platform::{HttpRequest, HttpResponse};
    use crate::testing::FakeTransport;
    use chrono::TimeZone;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    fn outbox() -> SharedOutbox {
        Arc::new(Mutex::new(
            Outbox::open_in_memory(&StaticKey([3; 32]), OutboxConfig::default()).unwrap(),
        ))
    }

    fn add(o: &SharedOutbox, body: EventBody, session: Uuid) -> Envelope {
        lock(o)
            .append(NewEvent {
                organization_id: "org".into(),
                device_id: "dev".into(),
                session_id: session,
                policy_version: 1,
                body,
                occurred_at: Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap(),
                monotonic_ms: 0,
            })
            .unwrap()
    }

    fn bucket() -> EventBody {
        EventBody::ActivityBucket(ActivityBucket {
            bucket_start: Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap(),
            active_seconds: 1,
            idle_seconds: 0,
            keyboard_count: 0,
            mouse_count: 0,
            data_quality: DataQuality::Ok,
        })
    }

    fn batch_events(req: &HttpRequest) -> Vec<Value> {
        let v: Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
        v["events"].as_array().unwrap().clone()
    }

    /// Responds to each batch with `status_for(event)` per event.
    fn respond_with(t: &FakeTransport, status_for: impl Fn(&Value) -> Value + Send + 'static) {
        t.set_handler(move |req| {
            let results: Vec<Value> = batch_events(req).iter().map(&status_for).collect();
            Some(Ok(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&json!({"server_time": "2026-10-28T09:00:00Z", "results": results}))
                    .unwrap(),
            }))
        });
    }

    fn setup() -> (SharedOutbox, Arc<FakeTransport>, ApiClient, FakeClock, Syncer) {
        let t = FakeTransport::new();
        let api = ApiClient::new("http://h", t.clone()).with_credential("c");
        (
            outbox(),
            t,
            api,
            FakeClock::new(Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap()),
            Syncer::new(StdRng::seed_from_u64(1)),
        )
    }

    #[test]
    fn sends_oldest_first_in_batches_of_at_most_500() {
        let (o, t, api, clock, mut s) = setup();
        for _ in 0..1203 {
            add(&o, bucket(), Uuid::nil());
        }
        respond_with(&t, |e| json!({"event_id": e["event_id"], "status": "accepted"}));
        let r = s.sync(&o, &api, &clock).unwrap();
        assert_eq!(r.accepted, 1203);
        assert_eq!(r.remaining, 0);
        let reqs = t.requests_to("/v1/ingestion/event-batches");
        let sizes: Vec<_> = reqs.iter().map(|r| batch_events(r).len()).collect();
        assert_eq!(sizes, vec![500, 500, 203]);
        let seqs: Vec<u64> = reqs
            .iter()
            .flat_map(batch_events)
            .map(|e| e["sequence"].as_u64().unwrap())
            .collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "oldest first");
        assert_eq!(seqs.len(), 1203);
        let body: Value = serde_json::from_slice(reqs[0].body.as_ref().unwrap()).unwrap();
        assert!(body["batch_id"].as_str().unwrap().len() == 36);
        assert!(body["sent_at"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn handles_per_event_results() {
        let (o, t, api, clock, mut s) = setup();
        let session = Uuid::new_v4();
        let start = add(&o, EventBody::SessionStarted(SessionStarted::default()), session);
        let dup = add(&o, bucket(), session);
        let rej = add(&o, bucket(), session);
        let missing = add(&o, bucket(), session);
        let unknown = add(&o, bucket(), session);
        let (s_id, d_id, r_id, u_id) = (start.event_id, dup.event_id, rej.event_id, unknown.event_id);
        respond_with(&t, move |e| {
            let id: Uuid = e["event_id"].as_str().unwrap().parse().unwrap();
            if id == s_id {
                json!({"event_id": id, "status": "rejected", "reason": "overlapping_session"})
            } else if id == d_id {
                json!({"event_id": id, "status": "duplicate"})
            } else if id == r_id {
                json!({"event_id": id, "status": "rejected", "reason": "unknown_session"})
            } else if id == u_id {
                json!({"event_id": id, "status": "later"})
            } else {
                json!({"event_id": Uuid::nil(), "status": "accepted"})
            }
        });
        let r = s.sync(&o, &api, &clock);
        // First batch makes progress; second (only kept events) makes none → backoff.
        let partial = match r {
            Err(SyncError::Failed { partial, .. }) => partial,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(partial.duplicate, 1);
        assert_eq!(partial.rejected, 2);
        assert_eq!(partial.overlapping_sessions, vec![session]);
        let left: Vec<_> = lock(&o).peek_oldest(10).unwrap().iter().map(|e| e.event_id).collect();
        assert_eq!(left, vec![missing.event_id, unknown.event_id]);
        let rejections = lock(&o).rejections(10).unwrap();
        let reasons: Vec<_> = rejections.iter().map(|r| r.reason.as_str()).collect();
        assert_eq!(reasons, vec!["unknown_session", "overlapping_session"]);
        assert!(s.backoff().failures() > 0);
    }

    #[test]
    fn network_and_server_errors_keep_events_and_back_off() {
        let (o, t, api, clock, mut s) = setup();
        add(&o, bucket(), Uuid::nil());
        t.fail_next("connection refused");
        assert!(matches!(s.sync(&o, &api, &clock), Err(SyncError::Failed { .. })));
        assert_eq!(lock(&o).depth().unwrap(), 1);
        // Immediately retrying is refused by the backoff without a request.
        let n = t.requests().len();
        assert!(matches!(s.sync(&o, &api, &clock), Err(SyncError::BackingOff(_))));
        assert_eq!(t.requests().len(), n);
        clock.advance(Duration::from_secs(1));
        t.push_raw(503, vec![]);
        assert!(matches!(s.sync(&o, &api, &clock), Err(SyncError::Failed { .. })));
        assert_eq!(s.backoff().failures(), 2);
        clock.advance(Duration::from_secs(2));
        respond_with(&t, |e| json!({"event_id": e["event_id"], "status": "accepted"}));
        let r = s.sync(&o, &api, &clock).unwrap();
        assert_eq!(r.accepted, 1);
        assert_eq!(s.backoff().failures(), 0);
    }

    #[test]
    fn device_revoked_is_surfaced() {
        let (o, t, api, clock, mut s) = setup();
        add(&o, bucket(), Uuid::nil());
        t.push(401, json!({"error": {"code": "device_revoked", "message": "revoked"}}));
        assert!(matches!(s.sync(&o, &api, &clock), Err(SyncError::Revoked)));
        assert_eq!(lock(&o).depth().unwrap(), 1, "the runtime wipes, not the syncer");
    }

    #[test]
    fn poison_event_is_isolated_by_bisection() {
        let (o, t, api, clock, mut s) = setup();
        let mut ids = vec![];
        for _ in 0..8 {
            ids.push(add(&o, bucket(), Uuid::nil()).event_id);
        }
        let poison = ids[5];
        t.set_handler(move |req| {
            let evs = batch_events(req);
            if evs.iter().any(|e| e["event_id"] == poison.to_string()) {
                return Some(Ok(HttpResponse {
                    status: 400,
                    body: serde_json::to_vec(&json!({"error": {"code": "invalid_batch"}})).unwrap(),
                }));
            }
            let results: Vec<Value> = evs
                .iter()
                .map(|e| json!({"event_id": e["event_id"], "status": "accepted"}))
                .collect();
            Some(Ok(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&json!({"results": results})).unwrap(),
            }))
        });
        let r = s.sync(&o, &api, &clock).unwrap();
        assert_eq!(r.accepted, 7);
        assert_eq!(r.rejected, 1);
        assert_eq!(lock(&o).depth().unwrap(), 0);
        assert_eq!(lock(&o).rejections(1).unwrap()[0].reason, "invalid_batch");
    }

    #[test]
    fn backoff_grows_to_five_minutes_with_jitter() {
        let mut b = Backoff::default();
        let mut rng = StdRng::seed_from_u64(9);
        let mut last_nominal = Duration::ZERO;
        for i in 1..=20 {
            let d = b.failure(Duration::ZERO, &mut rng);
            let nominal = b.nominal_delay(i);
            assert!(d >= nominal / 2 && d <= nominal, "{d:?} vs {nominal:?}");
            assert!(nominal >= last_nominal);
            last_nominal = nominal;
        }
        assert_eq!(b.nominal_delay(1), Duration::from_secs(1));
        assert_eq!(b.nominal_delay(2), Duration::from_secs(2));
        assert_eq!(b.nominal_delay(20), Duration::from_secs(300));
        b.success();
        assert!(b.ready(Duration::ZERO));
    }

    #[test]
    fn oversized_batches_are_split_below_the_byte_limit() {
        let (o, t, api, clock, s) = setup();
        let mut s = s.with_max_bytes(3000);
        for _ in 0..10 {
            add(
                &o,
                EventBody::AppUsage(crate::events::AppUsage {
                    app_identifier: "x".repeat(255),
                    app_name: "y".repeat(255),
                    domain: None,
                    started_at: Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap(),
                    duration_seconds: 1,
                }),
                Uuid::nil(),
            );
        }
        respond_with(&t, |e| json!({"event_id": e["event_id"], "status": "accepted"}));
        let r = s.sync(&o, &api, &clock).unwrap();
        assert_eq!(r.accepted, 10);
        let reqs = t.requests();
        assert!(reqs.len() >= 4, "10 × ~700 B events must be split");
        for req in reqs {
            assert!(req.body.unwrap().len() <= 3000);
        }
    }
}
