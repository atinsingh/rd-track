//! Simulated platform for headless runs (CI, development on Linux).
//!
//! Deterministic for a given seed: an employee alternates between bursts of input and
//! idle stretches, switches between a handful of fictional applications, and the
//! "screen" is a solid colour. Nothing here touches real input devices or the display.

use std::sync::Mutex;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rd_agent_core::platform::{
    CaptureError, ForegroundApp, ForegroundAppInfo, InputCounter, InputSample, PermissionStatus,
    RawFrame, ScreenCapturer,
};

/// Simulated input: alternating active (30–600 s) and idle (10–900 s) phases.
/// Assumes it is sampled once per second.
pub struct SimInput {
    rng: StdRng,
    active: bool,
    phase_left: u32,
    since_last_input: f64,
    capturing: bool,
}

impl SimInput {
    /// Creates a simulator from a seed.
    pub fn new(seed: u64) -> Self {
        let mut rng = StdRng::seed_from_u64(seed);
        let phase_left = rng.gen_range(30..=600);
        Self {
            rng,
            active: true,
            phase_left,
            since_last_input: 0.0,
            capturing: false,
        }
    }
}

impl InputCounter for SimInput {
    fn set_capturing(&mut self, capturing: bool) {
        self.capturing = capturing;
    }

    fn sample(&mut self) -> InputSample {
        if self.phase_left == 0 {
            self.active = !self.active;
            self.phase_left = if self.active {
                self.rng.gen_range(30..=600)
            } else {
                self.rng.gen_range(10..=900)
            };
        }
        self.phase_left -= 1;
        let (keyboard_count, mouse_count) = if self.active && self.rng.gen_bool(0.85) {
            (self.rng.gen_range(0..=8), self.rng.gen_range(0..=25))
        } else {
            (0, 0)
        };
        if keyboard_count + mouse_count > 0 {
            self.since_last_input = self.rng.gen_range(0.0..0.9);
        } else {
            self.since_last_input += 1.0;
        }
        InputSample {
            keyboard_count,
            mouse_count,
            counts_available: true,
            seconds_since_last_input: Some(self.since_last_input),
        }
    }

    fn permission(&self) -> PermissionStatus {
        PermissionStatus::Granted
    }
}

const APPS: &[(&str, &str)] = &[
    ("com.example.editor", "Example Editor"),
    ("com.example.browser", "Example Browser"),
    ("com.example.chat", "Example Chat"),
    ("com.example.terminal", "Example Terminal"),
    ("com.example.spreadsheet", "Example Sheets"),
];

/// Simulated foreground app: switches between fictional apps every 20–300 samples.
pub struct SimForeground {
    rng: StdRng,
    current: usize,
    left: u32,
    pinned: Option<ForegroundAppInfo>,
}

impl SimForeground {
    /// Creates a simulator from a seed.
    pub fn new(seed: u64) -> Self {
        let mut rng = StdRng::seed_from_u64(seed ^ 0x5eed_f00d);
        let current = rng.gen_range(0..APPS.len());
        let left = rng.gen_range(20..=300);
        Self {
            rng,
            current,
            left,
            pinned: None,
        }
    }

    /// Always reports `app_identifier` (e.g. `com.google.Chrome`, to try the browser
    /// extension on Linux).
    pub fn pinned(app_identifier: &str) -> Self {
        let mut s = Self::new(0);
        s.pinned = Some(ForegroundAppInfo {
            app_identifier: app_identifier.into(),
            app_name: app_identifier.into(),
        });
        s
    }
}

impl ForegroundApp for SimForeground {
    fn current(&mut self) -> Option<ForegroundAppInfo> {
        if let Some(p) = &self.pinned {
            return Some(p.clone());
        }
        if self.left == 0 {
            self.current = self.rng.gen_range(0..APPS.len());
            self.left = self.rng.gen_range(20..=300);
        }
        self.left -= 1;
        let (id, name) = APPS[self.current];
        Some(ForegroundAppInfo {
            app_identifier: id.into(),
            app_name: name.into(),
        })
    }

    fn permission(&self) -> PermissionStatus {
        PermissionStatus::NotRequired
    }
}

/// Simulated screen: a solid-colour 1920×1080 frame.
pub struct SimCapturer {
    color: [u8; 4],
    captures: Mutex<u64>,
}

impl SimCapturer {
    /// Width of the simulated screen.
    pub const WIDTH: u32 = 1920;
    /// Height of the simulated screen.
    pub const HEIGHT: u32 = 1080;

    /// Creates a capturer whose colour derives from the seed.
    pub fn new(seed: u64) -> Self {
        let mut rng = StdRng::seed_from_u64(seed ^ 0xc0_10_25);
        Self {
            color: [rng.gen(), rng.gen(), rng.gen(), 255],
            captures: Mutex::new(0),
        }
    }

    /// Number of captures taken.
    #[cfg(test)]
    pub fn captures(&self) -> u64 {
        *self.captures.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl ScreenCapturer for SimCapturer {
    fn capture(&self, _primary_monitor_only: bool) -> Result<RawFrame, CaptureError> {
        *self.captures.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        Ok(RawFrame {
            width: Self::WIDTH,
            height: Self::HEIGHT,
            rgba: self.color.repeat((Self::WIDTH * Self::HEIGHT) as usize),
        })
    }

    fn permission(&self) -> PermissionStatus {
        PermissionStatus::Granted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_is_deterministic_and_alternates() {
        let mut a = SimInput::new(7);
        let mut b = SimInput::new(7);
        let sa: Vec<_> = (0..3000).map(|_| a.sample()).collect();
        let sb: Vec<_> = (0..3000).map(|_| b.sample()).collect();
        assert_eq!(sa, sb);
        assert!(sa.iter().any(|s| s.keyboard_count > 0));
        assert!(sa
            .iter()
            .any(|s| s.seconds_since_last_input.unwrap() > 60.0));
    }

    #[test]
    fn apps_rotate_and_capture_is_solid() {
        let mut f = SimForeground::new(1);
        let ids: std::collections::HashSet<_> = (0..5000)
            .filter_map(|_| f.current())
            .map(|a| a.app_identifier)
            .collect();
        assert!(ids.len() > 1);
        let c = SimCapturer::new(3);
        let frame = c.capture(true).unwrap();
        assert_eq!(frame.rgba.len(), (1920 * 1080 * 4) as usize);
        assert_eq!(&frame.rgba[..4], &frame.rgba[frame.rgba.len() - 4..]);
        assert_eq!(c.captures(), 1);
    }
}
