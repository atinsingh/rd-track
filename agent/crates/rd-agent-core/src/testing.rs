//! Test doubles for the platform traits (compiled for tests only).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use crate::platform::{
    CaptureError, CredentialError, CredentialStore, ForegroundApp, ForegroundAppInfo, HttpRequest,
    HttpResponse, HttpTransport, InputCounter, InputSample, PermissionStatus, RawFrame,
    ScreenCapturer, TransportError,
};

type Handler = Box<dyn Fn(&HttpRequest) -> Option<Result<HttpResponse, TransportError>> + Send>;

#[derive(Default)]
struct TransportState {
    queue: VecDeque<Result<HttpResponse, TransportError>>,
    requests: Vec<HttpRequest>,
    handler: Option<Handler>,
}

/// Scripted HTTP transport: queued responses first, then the handler, else 500.
#[derive(Default)]
pub struct FakeTransport(Mutex<TransportState>);

impl FakeTransport {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn state(&self) -> std::sync::MutexGuard<'_, TransportState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn push(&self, status: u16, body: serde_json::Value) {
        self.push_raw(status, serde_json::to_vec(&body).unwrap());
    }
    pub fn push_raw(&self, status: u16, body: Vec<u8>) {
        self.state()
            .queue
            .push_back(Ok(HttpResponse { status, body }));
    }
    pub fn fail_next(&self, msg: &str) {
        self.state()
            .queue
            .push_back(Err(TransportError(msg.to_owned())));
    }
    pub fn set_handler(
        &self,
        f: impl Fn(&HttpRequest) -> Option<Result<HttpResponse, TransportError>> + Send + 'static,
    ) {
        self.state().handler = Some(Box::new(f));
    }
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.state().requests.clone()
    }
    pub fn requests_to(&self, path: &str) -> Vec<HttpRequest> {
        self.requests()
            .into_iter()
            .filter(|r| r.url.contains(path))
            .collect()
    }
}

impl HttpTransport for FakeTransport {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, TransportError> {
        let mut st = self.state();
        st.requests.push(req.clone());
        if let Some(r) = st.queue.pop_front() {
            return r;
        }
        if let Some(h) = &st.handler {
            if let Some(r) = h(&req) {
                return r;
            }
        }
        Ok(HttpResponse {
            status: 500,
            body: vec![],
        })
    }
}

/// In-memory credential store.
#[derive(Default)]
pub struct MemoryCredentials(Mutex<HashMap<String, Vec<u8>>>);

impl CredentialStore for MemoryCredentials {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), CredentialError> {
        self.0.lock().unwrap().insert(name.into(), value.to_vec());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), CredentialError> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

/// Shared, scriptable input state.
#[derive(Debug, Clone)]
pub struct InputScript {
    pub per_tick: InputSample,
    pub capturing: bool,
    pub samples_taken: usize,
}

/// Input counter whose next sample is controlled by the test.
#[derive(Clone)]
pub struct FakeInput(pub Arc<Mutex<InputScript>>);

impl FakeInput {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(InputScript {
            per_tick: InputSample {
                keyboard_count: 3,
                mouse_count: 5,
                counts_available: true,
                seconds_since_last_input: Some(0.1),
            },
            capturing: false,
            samples_taken: 0,
        })))
    }
    pub fn set(&self, s: InputSample) {
        self.0.lock().unwrap().per_tick = s;
    }
    pub fn idle(&self, since: f64) {
        self.set(InputSample {
            keyboard_count: 0,
            mouse_count: 0,
            counts_available: true,
            seconds_since_last_input: Some(since),
        });
    }
    pub fn capturing(&self) -> bool {
        self.0.lock().unwrap().capturing
    }
    pub fn samples_taken(&self) -> usize {
        self.0.lock().unwrap().samples_taken
    }
}

impl InputCounter for FakeInput {
    fn set_capturing(&mut self, capturing: bool) {
        self.0.lock().unwrap().capturing = capturing;
    }
    fn sample(&mut self) -> InputSample {
        let mut g = self.0.lock().unwrap();
        g.samples_taken += 1;
        g.per_tick
    }
    fn permission(&self) -> PermissionStatus {
        PermissionStatus::Granted
    }
}

/// Foreground app controlled by the test.
#[derive(Clone)]
pub struct FakeForeground(pub Arc<Mutex<Option<ForegroundAppInfo>>>);

impl FakeForeground {
    pub fn new(id: &str) -> Self {
        let f = Self(Arc::new(Mutex::new(None)));
        f.set(Some(id));
        f
    }
    pub fn set(&self, id: Option<&str>) {
        *self.0.lock().unwrap() = id.map(|i| ForegroundAppInfo {
            app_identifier: i.into(),
            app_name: format!("{i} app"),
        });
    }
}

impl ForegroundApp for FakeForeground {
    fn current(&mut self) -> Option<ForegroundAppInfo> {
        self.0.lock().unwrap().clone()
    }
}

/// Screen capturer returning a solid frame and counting captures.
#[derive(Default)]
pub struct FakeCapturer {
    pub captures: Mutex<usize>,
    pub width: u32,
    pub height: u32,
}

impl FakeCapturer {
    pub fn new(width: u32, height: u32) -> Arc<Self> {
        Arc::new(Self {
            captures: Mutex::new(0),
            width,
            height,
        })
    }
    pub fn count(&self) -> usize {
        *self.captures.lock().unwrap()
    }
}

impl ScreenCapturer for FakeCapturer {
    fn capture(&self, _primary: bool) -> Result<RawFrame, CaptureError> {
        *self.captures.lock().unwrap() += 1;
        Ok(RawFrame {
            width: self.width,
            height: self.height,
            rgba: [10u8, 20, 30, 255].repeat((self.width * self.height) as usize),
        })
    }
}
