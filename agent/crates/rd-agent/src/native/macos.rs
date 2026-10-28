//! macOS collectors (`objc2-*` bindings).
//!
//! * [`CounterInput`]: deltas of the HID system's event counters
//!   (`CGEventSourceCounterForEventType`) for key-down and mouse events, and
//!   `CGEventSourceSecondsSinceLastEventType` for idle time. No event tap is installed,
//!   so no keystroke ever reaches this process. If the counters stay flat while the idle
//!   timer shows input (some macOS releases may gate them behind Input Monitoring),
//!   counts are reported unavailable — see [`super::logic::CounterHealth`].
//! * [`MacForeground`]: `NSWorkspace.sharedWorkspace.frontmostApplication` →
//!   `bundleIdentifier` / `localizedName`. Window titles are never read.
//! * [`DisplayCapturer`]: `CGDisplayCreateImage` of the main display, drawn into an
//!   RGBA bitmap context at the policy's maximum width. Requires Screen Recording,
//!   checked with `CGPreflightScreenCaptureAccess` (never prompts); the prompt itself
//!   is only ever requested through [`super::request_permission_once`].
//!   `CGDisplayCreateImage` is deprecated in favour of ScreenCaptureKit (macOS 14+),
//!   which replaces it in a later increment.
#![allow(unsafe_code)]

use objc2::rc::autoreleasepool;
use objc2::MainThreadMarker;
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRunLoop, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGEventSource, CGEventSourceStateID,
    CGEventType, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo, CGInterpolationQuality,
    CGMainDisplayID, CGPreflightListenEventAccess, CGPreflightScreenCaptureAccess,
    CGRequestListenEventAccess, CGRequestScreenCaptureAccess,
};
use rd_agent_core::platform::{
    CaptureError, ForegroundApp, ForegroundAppInfo, InputCounter, InputSample, PermissionStatus,
    RawFrame, ScreenCapturer,
};
use rd_agent_core::screenshot::scaled_size;

use super::logic::{counter_delta, force_opaque, CounterHealth};
use super::Permission;

const STATE: CGEventSourceStateID = CGEventSourceStateID::HIDSystemState;
/// `kCGAnyInputEventType`.
const ANY_INPUT: CGEventType = CGEventType(u32::MAX);
const MOUSE_TYPES: [CGEventType; 8] = [
    CGEventType::MouseMoved,
    CGEventType::LeftMouseDown,
    CGEventType::RightMouseDown,
    CGEventType::OtherMouseDown,
    CGEventType::LeftMouseDragged,
    CGEventType::RightMouseDragged,
    CGEventType::OtherMouseDragged,
    CGEventType::ScrollWheel,
];

/// Current counter values: `[key_down, mouse types…]`.
fn read_counters() -> [u32; 9] {
    let mut out = [0u32; 9];
    out[0] = CGEventSource::counter_for_event_type(STATE, CGEventType::KeyDown);
    for (o, t) in out[1..].iter_mut().zip(MOUSE_TYPES) {
        *o = CGEventSource::counter_for_event_type(STATE, t);
    }
    out
}

/// Input counts from HID event counters.
pub struct CounterInput {
    last: Option<[u32; 9]>,
    health: CounterHealth,
}

impl CounterInput {
    /// Creates the counter (baseline taken on [`InputCounter::set_capturing`]`(true)`).
    pub fn new() -> Self {
        Self {
            last: None,
            health: CounterHealth::default(),
        }
    }
}

impl Default for CounterInput {
    fn default() -> Self {
        Self::new()
    }
}

impl InputCounter for CounterInput {
    fn set_capturing(&mut self, capturing: bool) {
        // Counters are free-running; "capturing" only means "take deltas from here".
        self.last = capturing.then(read_counters);
    }

    fn sample(&mut self) -> InputSample {
        let since = CGEventSource::seconds_since_last_event_type(STATE, ANY_INPUT);
        let since = (since.is_finite() && since >= 0.0).then_some(since);
        let now = read_counters();
        let prev = self.last.replace(now).unwrap_or(now);
        let keyboard_count = counter_delta(prev[0], now[0]);
        let mouse_count = prev[1..].iter().zip(&now[1..]).fold(0u32, |acc, (p, n)| {
            acc.saturating_add(counter_delta(*p, *n))
        });
        let input_seen = since.is_some_and(|s| s < 1.0);
        let available = self.health.observe(
            input_seen,
            u64::from(keyboard_count) + u64::from(mouse_count),
        );
        InputSample {
            keyboard_count: if available { keyboard_count } else { 0 },
            mouse_count: if available { mouse_count } else { 0 },
            counts_available: available,
            seconds_since_last_input: since,
        }
    }

    fn permission(&self) -> PermissionStatus {
        if CGPreflightListenEventAccess() {
            PermissionStatus::Granted
        } else if self.health.broken() {
            PermissionStatus::Denied
        } else {
            PermissionStatus::NotRequired
        }
    }
}

/// Frontmost application via `NSWorkspace`.
pub struct MacForeground;

impl MacForeground {
    /// Creates the source.
    pub fn new() -> Self {
        Self
    }
}

impl Default for MacForeground {
    fn default() -> Self {
        Self::new()
    }
}

impl ForegroundApp for MacForeground {
    fn current(&mut self) -> Option<ForegroundAppInfo> {
        // `frontmostApplication` is updated from workspace notifications delivered on
        // the main run loop. The tray app runs that loop; the headless CLI ticks on the
        // main thread, so give pending notifications a chance to be processed here.
        if MainThreadMarker::new().is_some() {
            // SAFETY: reading an immutable CoreFoundation constant.
            let mode = unsafe { kCFRunLoopDefaultMode };
            CFRunLoop::run_in_mode(mode, 0.0, true);
        }
        autoreleasepool(|_| {
            let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            let bundle = app.bundleIdentifier().map(|s| s.to_string());
            let name = app.localizedName().map(|s| s.to_string());
            let identifier = bundle.clone().or_else(|| name.clone())?;
            Some(ForegroundAppInfo {
                app_name: name.unwrap_or_else(|| identifier.clone()),
                app_identifier: identifier,
            })
        })
    }
}

/// Main-display capture with `CGDisplayCreateImage`.
pub struct DisplayCapturer;

impl ScreenCapturer for DisplayCapturer {
    fn capture(&self, primary_monitor_only: bool) -> Result<RawFrame, CaptureError> {
        self.capture_scaled(primary_monitor_only, u32::MAX)
    }

    /// Always the main display (`primary_monitor_only = false` falls back to it).
    fn capture_scaled(
        &self,
        _primary_monitor_only: bool,
        max_width: u32,
    ) -> Result<RawFrame, CaptureError> {
        if !CGPreflightScreenCaptureAccess() {
            // Without the permission macOS returns only the wallpaper: never upload that.
            return Err(CaptureError::PermissionMissing);
        }
        autoreleasepool(|_| {
            #[allow(deprecated)]
            let image = objc2_core_graphics::CGDisplayCreateImage(CGMainDisplayID())
                .ok_or_else(|| CaptureError::Failed("CGDisplayCreateImage returned null".into()))?;
            let (w, h) = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
            let w = u32::try_from(w).map_err(|_| CaptureError::Failed("width".into()))?;
            let h = u32::try_from(h).map_err(|_| CaptureError::Failed("height".into()))?;
            let (dw, dh) = scaled_size(w, h, max_width);
            if dw == 0 || dh == 0 {
                return Err(CaptureError::Failed("empty display image".into()));
            }
            let (dwu, dhu) = (dw as usize, dh as usize);
            let mut buf = vec![0u8; dwu * dhu * 4];
            let space = CGColorSpace::new_device_rgb()
                .ok_or_else(|| CaptureError::Failed("no RGB colour space".into()))?;
            let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
            // SAFETY: `buf` is a writable dw×dh×4 byte buffer that outlives `ctx` (dropped
            // at the end of this closure, before `buf` is moved out); 8 bits per
            // component, `dw * 4` bytes per row, RGBA byte order matches `info`.
            let ctx = unsafe {
                CGBitmapContextCreate(
                    buf.as_mut_ptr().cast(),
                    dwu,
                    dhu,
                    8,
                    dwu * 4,
                    Some(&space),
                    info,
                )
            }
            .ok_or_else(|| CaptureError::Failed("CGBitmapContextCreate failed".into()))?;
            CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::High);
            let rect = CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(f64::from(dw), f64::from(dh)),
            );
            CGContext::draw_image(Some(&ctx), rect, Some(&image));
            drop(ctx);
            force_opaque(&mut buf);
            Ok(RawFrame {
                width: dw,
                height: dh,
                rgba: buf,
            })
        })
    }

    fn permission(&self) -> PermissionStatus {
        if CGPreflightScreenCaptureAccess() {
            PermissionStatus::Granted
        } else {
            PermissionStatus::Denied
        }
    }
}

/// Triggers the system prompt for `p`. Callers go through
/// [`super::request_permission_once`], which guarantees at most one call per install.
pub(super) fn request(p: Permission) {
    match p {
        Permission::ScreenRecording => {
            let _ = CGRequestScreenCaptureAccess();
        }
        Permission::InputMonitoring => {
            let _ = CGRequestListenEventAccess();
        }
        Permission::Accessibility => {}
    }
}
