//! Screenshot scheduling and the capture pipeline (system design §6.5).
//!
//! **Scheduling.** Time is cut into windows of `interval_minutes`, the first starting
//! when capture first becomes possible in a session. Each window gets one capture time
//! drawn uniformly at random. A slot fires only if the agent is `Active` at that moment
//! (the scheduler is polled only on `Active` ticks) and is honoured only within a short
//! tolerance; a slot that passed while paused, suspended or stopped is consumed as
//! *missed*, never caught up. Hence at most one capture per window and none while paused.
//!
//! **Pipeline.** request upload intent → capture → downscale to `max_width_px` → JPEG
//! encode → `PUT` to the presigned URL → `complete`. The capture happens only after the
//! server authorised it, so nothing is ever captured offline, and a [`CaptureGate`]
//! closed by stop/pause aborts any job that has not captured yet.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::{DateTime, TimeDelta, Utc};
use rand::Rng;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::api::{
    ApiClient, ApiError, CompleteRequest, ImageContentType, UploadIntentRequest,
    UploadIntentResponse,
};
use crate::clock::Clock;
use crate::platform::{RawFrame, ScreenCapturer};

/// JPEG quality used for screenshots.
pub const JPEG_QUALITY: u8 = 70;

/// Result of polling the scheduler on an `Active` tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotDecision {
    /// Nothing to do.
    NotDue,
    /// The slot is now: capture (subject to the remaining gates).
    Due,
    /// The slot passed while capture was impossible; skipped for this window.
    Missed,
}

/// One random capture slot per interval.
#[derive(Debug, Clone)]
pub struct ScreenshotScheduler {
    interval: TimeDelta,
    tolerance: TimeDelta,
    window_start: Option<DateTime<Utc>>,
    slot: DateTime<Utc>,
    consumed: bool,
}

impl ScreenshotScheduler {
    /// Creates a scheduler; `tolerance` is how late a slot may still fire (2 ticks).
    pub fn new(interval: TimeDelta, tolerance: TimeDelta) -> Self {
        Self {
            interval: interval.max(TimeDelta::seconds(1)),
            tolerance,
            window_start: None,
            slot: DateTime::<Utc>::MIN_UTC,
            consumed: true,
        }
    }

    /// The current interval.
    pub fn interval(&self) -> TimeDelta {
        self.interval
    }

    /// The pending slot, if one is scheduled and not consumed.
    pub fn next_slot(&self) -> Option<DateTime<Utc>> {
        (self.window_start.is_some() && !self.consumed).then_some(self.slot)
    }

    /// Forgets the window (new session, or screenshots disabled).
    pub fn clear(&mut self) {
        self.window_start = None;
        self.consumed = true;
    }

    /// Changes the interval; a new window starts at `now` if it actually changed.
    pub fn set_interval(&mut self, interval: TimeDelta, now: DateTime<Utc>, rng: &mut impl Rng) {
        let interval = interval.max(TimeDelta::seconds(1));
        if interval != self.interval {
            self.interval = interval;
            if self.window_start.is_some() {
                self.start_window(now, rng);
            }
        }
    }

    fn start_window(&mut self, start: DateTime<Utc>, rng: &mut impl Rng) {
        let ms = self.interval.num_milliseconds().max(1);
        self.window_start = Some(start);
        self.slot = start + TimeDelta::milliseconds(rng.gen_range(0..ms));
        self.consumed = false;
    }

    /// Polls on an `Active` tick at `now`.
    pub fn poll(&mut self, now: DateTime<Utc>, rng: &mut impl Rng) -> SlotDecision {
        let Some(mut ws) = self.window_start else {
            self.start_window(now, rng);
            return self.poll_slot(now);
        };
        if now >= ws + self.interval {
            let ms = self.interval.num_milliseconds().max(1);
            let k = (now - ws).num_milliseconds() / ms;
            ws += TimeDelta::milliseconds(k.saturating_mul(ms));
            self.start_window(ws, rng);
        }
        self.poll_slot(now)
    }

    fn poll_slot(&mut self, now: DateTime<Utc>) -> SlotDecision {
        if self.consumed || now < self.slot {
            return SlotDecision::NotDue;
        }
        self.consumed = true;
        if now - self.slot <= self.tolerance {
            SlotDecision::Due
        } else {
            SlotDecision::Missed
        }
    }
}

/// Closes every outstanding [`CaptureGate`] when capture must stop.
#[derive(Debug, Clone, Default)]
pub struct GateController(Arc<AtomicU64>);

impl GateController {
    /// Creates a controller.
    pub fn new() -> Self {
        Self::default()
    }
    /// A gate that stays open until the next [`GateController::close_all`].
    pub fn gate(&self) -> CaptureGate {
        CaptureGate {
            epoch: Arc::clone(&self.0),
            expected: self.0.load(Ordering::SeqCst),
        }
    }
    /// Closes all gates handed out so far (stop, pause, suspend, revocation).
    pub fn close_all(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// Permission for one in-flight screenshot job to keep going.
#[derive(Debug, Clone)]
pub struct CaptureGate {
    epoch: Arc<AtomicU64>,
    expected: u64,
}

impl CaptureGate {
    /// `true` while the session that requested the job is still `Active`.
    pub fn is_open(&self) -> bool {
        self.epoch.load(Ordering::SeqCst) == self.expected
    }
}

/// A screenshot the tick loop decided to take.
#[derive(Debug, Clone)]
pub struct ScreenshotJob {
    /// Session.
    pub session_id: Uuid,
    /// `screenshots.max_width_px`.
    pub max_width: u32,
    /// `screenshots.primary_monitor_only`.
    pub primary_monitor_only: bool,
    /// `screenshots.blur`.
    pub blur: bool,
    /// Closed if the session leaves `Active` before capture.
    pub gate: CaptureGate,
}

/// Receives screenshot jobs from the tick loop.
pub trait ScreenshotSink {
    /// Hands a job to whoever runs the pipeline (the network thread in production).
    fn dispatch(&mut self, job: ScreenshotJob);
}

/// Outcome of [`run_job`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenshotOutcome {
    /// Uploaded and completed.
    Completed {
        /// Server id.
        screenshot_id: String,
        /// Uploaded byte count.
        bytes: u64,
        /// Width after downscaling.
        width: u32,
        /// Height after downscaling.
        height: u32,
    },
    /// The server refused the intent (e.g. `403 screenshots_disabled`).
    Refused(String),
    /// The session left `Active` before capture; nothing was captured.
    Cancelled,
    /// Capture, encode, upload or complete failed.
    Failed(String),
}

/// The server side of the pipeline (implemented by [`ApiClient`]).
pub trait ScreenshotApi {
    /// Requests an upload intent.
    fn create_intent(&self, session_id: Uuid) -> Result<UploadIntentResponse, ApiError>;
    /// Uploads the bytes.
    fn upload(&self, intent: &UploadIntentResponse, bytes: Vec<u8>) -> Result<(), ApiError>;
    /// Reports completion.
    fn complete(&self, req: &CompleteRequest) -> Result<(), ApiError>;
}

impl ScreenshotApi for ApiClient {
    fn create_intent(&self, session_id: Uuid) -> Result<UploadIntentResponse, ApiError> {
        self.upload_intent(&UploadIntentRequest {
            session_id,
            content_type: ImageContentType::Jpeg,
        })
    }
    fn upload(&self, intent: &UploadIntentResponse, bytes: Vec<u8>) -> Result<(), ApiError> {
        self.upload_object(intent, ImageContentType::Jpeg, bytes)
    }
    fn complete(&self, req: &CompleteRequest) -> Result<(), ApiError> {
        self.complete_screenshot(req).map(|_| ())
    }
}

/// Runs one job: intent → capture → downscale → (blur) → encode → upload → complete.
pub fn run_job(
    job: &ScreenshotJob,
    api: &dyn ScreenshotApi,
    capturer: &dyn ScreenCapturer,
    clock: &dyn Clock,
) -> ScreenshotOutcome {
    if !job.gate.is_open() {
        return ScreenshotOutcome::Cancelled;
    }
    let intent = match api.create_intent(job.session_id) {
        Ok(i) => i,
        Err(e) => {
            return match e {
                ApiError::LicenseUnavailable(block) => {
                    ScreenshotOutcome::Refused(block.code().into())
                }
                ApiError::Http { status: 403, code } => {
                    ScreenshotOutcome::Refused(code.unwrap_or_else(|| "forbidden".into()))
                }
                other => ScreenshotOutcome::Failed(other.to_string()),
            }
        }
    };
    if !job.gate.is_open() {
        return ScreenshotOutcome::Cancelled;
    }
    let frame = match capturer.capture_scaled(job.primary_monitor_only, job.max_width) {
        Ok(f) => f,
        Err(e) => return ScreenshotOutcome::Failed(e.to_string()),
    };
    let captured_at = clock.wall();
    if !job.gate.is_open() {
        // Stopped while capturing: discard the frame.
        return ScreenshotOutcome::Cancelled;
    }
    let frame = match downscale(&frame, job.max_width) {
        Ok(f) => f,
        Err(e) => return ScreenshotOutcome::Failed(e),
    };
    // Blurred here, before encoding: the sharp image never leaves this computer.
    let blurred = job.blur || intent.blur;
    let frame = if blurred {
        match blur(&frame) {
            Ok(f) => f,
            Err(e) => return ScreenshotOutcome::Failed(e),
        }
    } else {
        frame
    };
    let bytes = match encode_jpeg(&frame, JPEG_QUALITY) {
        Ok(b) => b,
        Err(e) => return ScreenshotOutcome::Failed(e),
    };
    let sha256 = hex(&Sha256::digest(&bytes));
    let len = bytes.len() as u64;
    if let Err(e) = api.upload(&intent, bytes) {
        return ScreenshotOutcome::Failed(e.to_string());
    }
    let req = CompleteRequest {
        screenshot_id: intent.screenshot_id.clone(),
        captured_at,
        sha256,
        bytes: len,
        width: frame.width,
        height: frame.height,
        blurred,
    };
    match api.complete(&req) {
        Ok(()) => ScreenshotOutcome::Completed {
            screenshot_id: intent.screenshot_id,
            bytes: len,
            width: frame.width,
            height: frame.height,
        },
        Err(e) => ScreenshotOutcome::Failed(e.to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn validate(frame: &RawFrame) -> Result<(), String> {
    let expected = u64::from(frame.width) * u64::from(frame.height) * 4;
    if frame.width == 0 || frame.height == 0 || frame.rgba.len() as u64 != expected {
        return Err("invalid frame dimensions".into());
    }
    Ok(())
}

/// The size a `width × height` frame has after [`downscale`] to `max_width`: unchanged
/// when it already fits, otherwise `max_width` wide with the height rounded to keep the
/// aspect ratio (at least 1). Native capturers use it to scale while capturing so the
/// pipeline's own downscale becomes a no-op.
pub fn scaled_size(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    let max_width = max_width.max(1);
    if width <= max_width || width == 0 {
        return (width, height);
    }
    let (sw, sh, dw) = (u64::from(width), u64::from(height), u64::from(max_width));
    let dh = ((sh * dw + sw / 2) / sw).max(1);
    (max_width, u32::try_from(dh).unwrap_or(u32::MAX))
}

/// Downscales (area average) so that `width <= max_width`, preserving aspect ratio.
pub fn downscale(frame: &RawFrame, max_width: u32) -> Result<RawFrame, String> {
    validate(frame)?;
    let max_width = max_width.max(1);
    if frame.width <= max_width {
        return Ok(frame.clone());
    }
    let (dw, dh) = scaled_size(frame.width, frame.height, max_width);
    area_resample(frame, dw, dh)
}

/// The smallest blur cell, in pixels: wider than a line of ordinary text.
pub const BLUR_MIN_CELL: u32 = 16;

/// Blurs a frame so text can't be read but windows and colours can still be told apart:
/// each cell of about 1/80 of the width (at least [`BLUR_MIN_CELL`] px) is averaged, then
/// the cells are blended smoothly back to full size. The result has the frame's size.
pub fn blur(frame: &RawFrame) -> Result<RawFrame, String> {
    validate(frame)?;
    let cell = (frame.width / 80).max(BLUR_MIN_CELL);
    let small = area_resample(
        frame,
        (frame.width / cell).max(1),
        (frame.height / cell).max(1),
    )?;
    upscale_bilinear(&small, frame.width, frame.height)
}

/// Bilinear resize of a small frame up to `dw × dh`, sampling at pixel centres.
fn upscale_bilinear(src: &RawFrame, dw: u32, dh: u32) -> Result<RawFrame, String> {
    let (sw, sh) = (src.width as usize, src.height as usize);
    let mut out = vec![
        0u8;
        usize::try_from(u64::from(dw) * u64::from(dh) * 4)
            .map_err(|_| "frame too large")?
    ];
    let axis = |d: u32, dsize: u32, ssize: usize| {
        let f = ((f64::from(d) + 0.5) * ssize as f64 / f64::from(dsize) - 0.5)
            .clamp(0.0, (ssize - 1) as f64);
        let i = f.floor() as usize;
        (i, (i + 1).min(ssize - 1), f - i as f64)
    };
    for y in 0..dh {
        let (y0, y1, fy) = axis(y, dh, sh);
        for x in 0..dw {
            let (x0, x1, fx) = axis(x, dw, sw);
            let px = |xx: usize, yy: usize, c: usize| f64::from(src.rgba[(yy * sw + xx) * 4 + c]);
            let o = (y as usize * dw as usize + x as usize) * 4;
            for c in 0..4 {
                let top = px(x0, y0, c) * (1.0 - fx) + px(x1, y0, c) * fx;
                let bottom = px(x0, y1, c) * (1.0 - fx) + px(x1, y1, c) * fx;
                out[o + c] = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Ok(RawFrame {
        width: dw,
        height: dh,
        rgba: out,
    })
}

/// Area-average resample to exactly `dw × dh` (no larger than the frame).
fn area_resample(frame: &RawFrame, dw: u32, dh: u32) -> Result<RawFrame, String> {
    let (sw, sh) = (u64::from(frame.width), u64::from(frame.height));
    let (dw, dh) = (
        u64::from(dw.min(frame.width).max(1)),
        u64::from(dh.min(frame.height).max(1)),
    );
    let mut out = vec![0u8; usize::try_from(dw * dh * 4).map_err(|_| "frame too large")?];
    for dy in 0..dh {
        let (y0, y1) = (dy * sh / dh, ((dy + 1) * sh / dh).max(dy * sh / dh + 1));
        for dx in 0..dw {
            let (x0, x1) = (dx * sw / dw, ((dx + 1) * sw / dw).max(dx * sw / dw + 1));
            let mut acc = [0u64; 4];
            for y in y0..y1 {
                let row = (y * sw) as usize * 4;
                for x in x0..x1 {
                    let i = row + x as usize * 4;
                    for (a, &v) in acc.iter_mut().zip(&frame.rgba[i..i + 4]) {
                        *a += u64::from(v);
                    }
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            let o = ((dy * dw + dx) * 4) as usize;
            for (dst, a) in out[o..o + 4].iter_mut().zip(acc) {
                *dst = u8::try_from(a / n).unwrap_or(u8::MAX);
            }
        }
    }
    Ok(RawFrame {
        width: u32::try_from(dw).unwrap_or(u32::MAX),
        height: u32::try_from(dh).unwrap_or(u32::MAX),
        rgba: out,
    })
}

/// Encodes an RGBA frame as baseline JPEG.
pub fn encode_jpeg(frame: &RawFrame, quality: u8) -> Result<Vec<u8>, String> {
    validate(frame)?;
    let w = u16::try_from(frame.width).map_err(|_| "frame too wide for JPEG")?;
    let h = u16::try_from(frame.height).map_err(|_| "frame too tall for JPEG")?;
    let mut buf = Vec::new();
    jpeg_encoder::Encoder::new(&mut buf, quality)
        .encode(&frame.rgba, w, h, jpeg_encoder::ColorType::Rgba)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::platform::CaptureError;
    use crate::testing::FakeCapturer;
    use chrono::TimeZone;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use std::cell::RefCell;

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap()
    }

    #[test]
    fn at_most_one_slot_per_interval_uniformly_placed() {
        let mut rng = StdRng::seed_from_u64(1);
        let interval = TimeDelta::minutes(10);
        let mut s = ScreenshotScheduler::new(interval, TimeDelta::seconds(2));
        let mut fired = vec![];
        // 10 hours of 1 s ticks.
        for i in 0..36_000 {
            let now = t0() + TimeDelta::seconds(i);
            if s.poll(now, &mut rng) == SlotDecision::Due {
                fired.push(now);
            }
        }
        assert_eq!(fired.len(), 60);
        for (k, f) in fired.iter().enumerate() {
            let ws = t0() + interval * i32::try_from(k).unwrap();
            assert!(
                *f >= ws && *f < ws + interval + TimeDelta::seconds(1),
                "slot {k} outside its window"
            );
        }
        // Not all slots at the same offset (randomised).
        let offsets: std::collections::HashSet<_> = fired
            .iter()
            .enumerate()
            .map(|(k, f)| (*f - (t0() + interval * i32::try_from(k).unwrap())).num_seconds())
            .collect();
        assert!(offsets.len() > 20);
    }

    fn expected(slot: DateTime<Utc>, now: DateTime<Utc>) -> SlotDecision {
        if slot > now {
            SlotDecision::NotDue
        } else if now - slot <= TimeDelta::seconds(2) {
            SlotDecision::Due
        } else {
            SlotDecision::Missed
        }
    }

    #[test]
    fn slots_passing_while_not_polled_are_missed_not_caught_up() {
        let interval = TimeDelta::minutes(10);
        let mut missed = 0;
        for seed in 0..200 {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut s = ScreenshotScheduler::new(interval, TimeDelta::seconds(2));
            if s.poll(t0(), &mut rng) != SlotDecision::NotDue {
                continue;
            }
            let slot = s.slot;
            // Paused from just after the start until 09:09:59: no polls in between.
            let resume = t0() + TimeDelta::minutes(9) + TimeDelta::seconds(59);
            let d = s.poll(resume, &mut rng);
            assert_eq!(d, expected(slot, resume));
            missed += usize::from(d == SlotDecision::Missed);
            // Whatever happened, nothing more fires in this window.
            assert_eq!(
                s.poll(resume + TimeDelta::milliseconds(500), &mut rng),
                SlotDecision::NotDue
            );
        }
        assert!(
            missed > 150,
            "most slots fall inside the pause and must be missed"
        );

        // After a 2 h gap the scheduler jumps to the current window and never fires late.
        for seed in 0..200 {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut s = ScreenshotScheduler::new(interval, TimeDelta::seconds(2));
            s.poll(t0(), &mut rng);
            let later = t0() + TimeDelta::hours(2) + TimeDelta::minutes(5);
            let d = s.poll(later, &mut rng);
            let ws = s.window_start.unwrap();
            assert_eq!(ws, t0() + TimeDelta::hours(2));
            assert_eq!(d, expected(s.slot, later));
        }
    }

    #[test]
    fn interval_change_starts_new_window() {
        let mut rng = StdRng::seed_from_u64(3);
        let mut s = ScreenshotScheduler::new(TimeDelta::minutes(15), TimeDelta::seconds(2));
        s.poll(t0(), &mut rng);
        s.set_interval(
            TimeDelta::minutes(30),
            t0() + TimeDelta::minutes(1),
            &mut rng,
        );
        let slot = s.next_slot().unwrap();
        assert!(slot >= t0() + TimeDelta::minutes(1));
        assert!(slot < t0() + TimeDelta::minutes(31));
        s.clear();
        assert!(s.next_slot().is_none());
    }

    #[derive(Default)]
    struct FakeApi {
        calls: RefCell<Vec<String>>,
        refuse: Option<String>,
        on_intent: Option<GateController>,
        uploaded: RefCell<Vec<u8>>,
        completed: RefCell<Option<CompleteRequest>>,
        blur: bool,
    }

    impl ScreenshotApi for FakeApi {
        fn create_intent(&self, _s: Uuid) -> Result<UploadIntentResponse, ApiError> {
            self.calls.borrow_mut().push("intent".into());
            if let Some(g) = &self.on_intent {
                g.close_all();
            }
            if let Some(code) = &self.refuse {
                return Err(ApiError::Http {
                    status: 403,
                    code: Some(code.clone()),
                });
            }
            Ok(UploadIntentResponse {
                screenshot_id: "shot-1".into(),
                upload_url: "http://minio/x".into(),
                upload_headers: Default::default(),
                expires_at: None,
                blur: self.blur,
            })
        }
        fn upload(&self, _i: &UploadIntentResponse, bytes: Vec<u8>) -> Result<(), ApiError> {
            self.calls.borrow_mut().push("upload".into());
            *self.uploaded.borrow_mut() = bytes;
            Ok(())
        }
        fn complete(&self, req: &CompleteRequest) -> Result<(), ApiError> {
            self.calls.borrow_mut().push("complete".into());
            *self.completed.borrow_mut() = Some(req.clone());
            Ok(())
        }
    }

    fn job(gates: &GateController) -> ScreenshotJob {
        ScreenshotJob {
            session_id: Uuid::nil(),
            max_width: 640,
            primary_monitor_only: true,
            blur: false,
            gate: gates.gate(),
        }
    }

    /// Black-on-white "text": one-pixel strokes every few pixels, like a page of writing.
    fn text_like(w: u32, h: u32) -> RawFrame {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let ink = (y % 6 < 4) && (x % 3 == 0 || (x + y) % 5 == 0);
                let v = if ink { 0 } else { 255 };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        RawFrame {
            width: w,
            height: h,
            rgba,
        }
    }

    /// Largest difference between horizontally neighbouring pixels (sharp edges = text).
    fn sharpest_edge(f: &RawFrame) -> u8 {
        let mut max = 0;
        for y in 0..f.height as usize {
            for x in 1..f.width as usize {
                let i = (y * f.width as usize + x) * 4;
                max = max.max(f.rgba[i].abs_diff(f.rgba[i - 4]));
            }
        }
        max
    }

    #[test]
    fn blur_leaves_no_readable_edges_but_keeps_the_layout() {
        let page = text_like(640, 360);
        assert_eq!(sharpest_edge(&page), 255);
        let b = blur(&page).unwrap();
        assert_eq!((b.width, b.height), (640, 360));
        assert!(sharpest_edge(&b) < 24, "edges left: {}", sharpest_edge(&b));

        // A red window on the left and a blue one on the right stay red and blue.
        let mut two = RawFrame {
            width: 640,
            height: 360,
            rgba: Vec::new(),
        };
        for _ in 0..360 {
            for x in 0..640 {
                two.rgba.extend_from_slice(if x < 320 {
                    &[220, 30, 30, 255]
                } else {
                    &[30, 30, 220, 255]
                });
            }
        }
        let b = blur(&two).unwrap();
        let at = |x: usize, y: usize| &b.rgba[(y * 640 + x) * 4..(y * 640 + x) * 4 + 3];
        assert_eq!(at(10, 180), &[220, 30, 30]);
        assert_eq!(at(630, 180), &[30, 30, 220]);
        // Tiny frames still work.
        assert_eq!(blur(&text_like(5, 3)).unwrap().width, 5);
    }

    #[test]
    fn blurs_before_encoding_when_the_policy_or_the_server_says_so() {
        let gates = GateController::new();
        let cap = FakeCapturer::new(1280, 720);
        let clock = FakeClock::new(t0());
        let api = FakeApi::default();
        run_job(&job(&gates), &api, cap.as_ref(), &clock);
        assert!(!api.completed.borrow().clone().unwrap().blurred);

        let mut j = job(&gates);
        j.blur = true;
        let api = FakeApi::default();
        run_job(&j, &api, cap.as_ref(), &clock);
        assert!(api.completed.borrow().clone().unwrap().blurred);

        // The server's word counts even when this computer's policy copy is older.
        let api = FakeApi {
            blur: true,
            ..Default::default()
        };
        run_job(&job(&gates), &api, cap.as_ref(), &clock);
        let done = api.completed.borrow().clone().unwrap();
        assert!(done.blurred);
        assert_eq!((done.width, done.height), (640, 360));
    }

    #[test]
    fn pipeline_runs_in_order_and_downscales() {
        let gates = GateController::new();
        let api = FakeApi::default();
        let cap = FakeCapturer::new(1920, 1080);
        let clock = FakeClock::new(t0());
        let out = run_job(&job(&gates), &api, cap.as_ref(), &clock);
        assert_eq!(*api.calls.borrow(), vec!["intent", "upload", "complete"]);
        let done = api.completed.borrow().clone().unwrap();
        assert_eq!((done.width, done.height), (640, 360));
        assert_eq!(done.captured_at, t0());
        let bytes = api.uploaded.borrow().clone();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "JPEG SOI marker");
        assert_eq!(done.bytes, bytes.len() as u64);
        assert_eq!(done.sha256, hex(&Sha256::digest(&bytes)));
        assert_eq!(done.sha256.len(), 64);
        assert!(matches!(
            out,
            ScreenshotOutcome::Completed { width: 640, .. }
        ));
    }

    #[test]
    fn refused_intent_or_closed_gate_never_captures() {
        let gates = GateController::new();
        let cap = FakeCapturer::new(800, 600);
        let clock = FakeClock::new(t0());

        let api = FakeApi {
            refuse: Some("session_not_active".into()),
            ..Default::default()
        };
        assert_eq!(
            run_job(&job(&gates), &api, cap.as_ref(), &clock),
            ScreenshotOutcome::Refused("session_not_active".into())
        );

        let j = job(&gates);
        gates.close_all();
        let api = FakeApi::default();
        assert_eq!(
            run_job(&j, &api, cap.as_ref(), &clock),
            ScreenshotOutcome::Cancelled
        );
        assert!(api.calls.borrow().is_empty());

        // Stop arrives while the intent request is in flight.
        let api = FakeApi {
            on_intent: Some(gates.clone()),
            ..Default::default()
        };
        assert_eq!(
            run_job(&job(&gates), &api, cap.as_ref(), &clock),
            ScreenshotOutcome::Cancelled
        );
        assert_eq!(cap.count(), 0);
    }

    #[test]
    fn downscale_preserves_aspect_and_color() {
        let f = RawFrame {
            width: 4,
            height: 2,
            rgba: [100u8, 150, 200, 255].repeat(8),
        };
        let d = downscale(&f, 2).unwrap();
        assert_eq!((d.width, d.height), (2, 1));
        assert_eq!(&d.rgba[..4], &[100, 150, 200, 255]);
        let same = downscale(&f, 1920).unwrap();
        assert_eq!(same, f);
        let bad = RawFrame {
            width: 4,
            height: 2,
            rgba: vec![0; 3],
        };
        assert!(downscale(&bad, 2).is_err());
        assert!(encode_jpeg(&bad, 70).is_err());
    }

    #[test]
    fn scaled_size_matches_downscale_and_is_idempotent() {
        assert_eq!(scaled_size(5120, 2880, 1280), (1280, 720));
        assert_eq!(scaled_size(2560, 1600, 1280), (1280, 800));
        assert_eq!(scaled_size(1366, 768, 640), (640, 360));
        assert_eq!(scaled_size(1000, 1000, 1920), (1000, 1000));
        assert_eq!(scaled_size(4000, 1, 640), (640, 1));
        assert_eq!(scaled_size(0, 0, 640), (0, 0));
        assert_eq!(scaled_size(10, 10, 0), (1, 1));
        for (w, h, m) in [(3, 7, 2), (1920, 1080, 1280), (3456, 2234, 1280)] {
            let f = RawFrame {
                width: w,
                height: h,
                rgba: vec![7; (w * h * 4) as usize],
            };
            let d = downscale(&f, m).unwrap();
            assert_eq!((d.width, d.height), scaled_size(w, h, m));
            // A frame pre-scaled by a native capturer passes through unchanged.
            let (sw, sh) = scaled_size(w, h, m);
            assert_eq!(scaled_size(sw, sh, m), (sw, sh));
        }
    }

    #[test]
    fn pipeline_passes_max_width_to_the_capturer() {
        struct Scaling(std::sync::Mutex<Option<u32>>);
        impl ScreenCapturer for Scaling {
            fn capture(&self, _p: bool) -> Result<RawFrame, CaptureError> {
                Err(CaptureError::Failed("unscaled path used".into()))
            }
            fn capture_scaled(&self, _p: bool, max_width: u32) -> Result<RawFrame, CaptureError> {
                *self.0.lock().unwrap() = Some(max_width);
                Ok(RawFrame {
                    width: 4,
                    height: 2,
                    rgba: vec![9; 32],
                })
            }
        }
        let gates = GateController::new();
        let cap = Scaling(std::sync::Mutex::new(None));
        let clock = FakeClock::new(t0());
        let out = run_job(&job(&gates), &FakeApi::default(), &cap, &clock);
        assert!(
            matches!(out, ScreenshotOutcome::Completed { .. }),
            "{out:?}"
        );
        assert_eq!(*cap.0.lock().unwrap(), Some(job(&gates).max_width));
    }
}
