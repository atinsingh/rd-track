//! Windows collectors (`windows-sys`).
//!
//! * [`HookInputCounter`]: low-level keyboard and mouse hooks on a dedicated
//!   message-loop thread, installed only while the session is `Active`. The hook
//!   procedures look at nothing but the message kind (`wParam`), bump an atomic counter
//!   and pass the event on — `lParam` (the `KBDLLHOOKSTRUCT` / `MSLLHOOKSTRUCT` with the
//!   virtual-key and scan codes) is never dereferenced. Idle time from `GetLastInputInfo`.
//! * [`WinForeground`]: `GetForegroundWindow` → owning process → image path. The
//!   identifier is the executable's file name, the display name its version-resource
//!   `FileDescription` (cached per path) or else the file stem. Window titles are never
//!   read.
//! * [`GdiCapturer`]: the primary monitor via GDI `StretchBlt` (HALFTONE) straight into
//!   a DIB of the policy's maximum width. Needs no permission. (DXGI Desktop Duplication
//!   is a later optimisation.)
//!
//! Every `unsafe` block is a single Win32 call or a short sequence of them with the
//! invariants stated next to it.
#![allow(unsafe_code)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use rd_agent_core::platform::{
    CaptureError, ForegroundApp, ForegroundAppInfo, InputCounter, InputSample, RawFrame,
    ScreenCapturer,
};
use rd_agent_core::screenshot::scaled_size;
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetSystemMetrics,
    GetWindowThreadProcessId, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, MSG, PM_NOREMOVE, SM_CXSCREEN, SM_CYSCREEN,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN, WM_USER,
};

use super::logic::{bgra_to_rgba, file_name, file_stem, idle_millis, utf16_until_nul};

// ----- input ---------------------------------------------------------------------

/// Key-down events since the last sample (hook procedures cannot capture state, so the
/// counters are process-wide; only one [`HookInputCounter`] is ever active).
static KEY_DOWNS: AtomicU32 = AtomicU32::new(0);
/// Mouse events (moves, buttons, wheel) since the last sample.
static MOUSE_EVENTS: AtomicU32 = AtomicU32::new(0);

/// `WH_KEYBOARD_LL` procedure: counts key-down messages. Reads only `wparam` (the
/// message kind); `lparam` is passed on untouched and never dereferenced.
unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && (wparam == WM_KEYDOWN as WPARAM || wparam == WM_SYSKEYDOWN as WPARAM)
    {
        KEY_DOWNS.fetch_add(1, Ordering::Relaxed);
    }
    // SAFETY: forwarding the unmodified arguments we were called with, as required.
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

/// `WH_MOUSE_LL` procedure: counts every mouse message. `lparam` (coordinates) is never
/// dereferenced.
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        MOUSE_EVENTS.fetch_add(1, Ordering::Relaxed);
    }
    // SAFETY: as in `keyboard_proc`.
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

/// The hook thread: installs both hooks, pumps messages (low-level hooks are called on
/// the installing thread's message loop) and removes the hooks on `WM_QUIT`.
struct HookThread {
    thread_id: u32,
    join: JoinHandle<()>,
}

impl HookThread {
    fn start() -> Option<(Self, bool)> {
        let (tx, rx) = mpsc::channel();
        let join = std::thread::Builder::new()
            .name("rd-agent-input-hooks".into())
            .spawn(move || {
                // SAFETY: plain Win32 calls on this thread. `msg` is a valid, writable
                // MSG. PeekMessageW creates the thread's message queue before we
                // publish the thread id, so PostThreadMessageW(WM_QUIT) cannot be lost.
                unsafe {
                    let mut msg: MSG = std::mem::zeroed();
                    PeekMessageW(&mut msg, null_mut(), WM_USER, WM_USER, PM_NOREMOVE);
                    let module = GetModuleHandleW(null());
                    let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
                    let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
                    let _ = tx.send((GetCurrentThreadId(), !kb.is_null() && !ms.is_null()));
                    while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    if !kb.is_null() {
                        UnhookWindowsHookEx(kb);
                    }
                    if !ms.is_null() {
                        UnhookWindowsHookEx(ms);
                    }
                }
            })
            .ok()?;
        let (thread_id, ok) = rx.recv().ok()?;
        Some((Self { thread_id, join }, ok))
    }

    fn stop(self) {
        // SAFETY: posting WM_QUIT to a thread id we own; harmless if it already exited.
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
        }
        let _ = self.join.join();
    }
}

/// Seconds since the last keyboard/mouse input anywhere in the session.
fn seconds_since_last_input() -> Option<f64> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set.
    let ok = unsafe { GetLastInputInfo(&mut info) } != 0;
    // SAFETY: no arguments.
    let now = unsafe { GetTickCount() };
    ok.then(|| f64::from(idle_millis(now, info.dwTime)) / 1000.0)
}

/// Counts input with low-level hooks (installed only while capturing).
pub struct HookInputCounter {
    hooks: Option<HookThread>,
    hooks_ok: bool,
}

impl HookInputCounter {
    /// Creates the counter (no hooks until [`InputCounter::set_capturing`]`(true)`).
    pub fn new() -> Self {
        Self {
            hooks: None,
            hooks_ok: false,
        }
    }
}

impl Default for HookInputCounter {
    fn default() -> Self {
        Self::new()
    }
}

impl InputCounter for HookInputCounter {
    fn set_capturing(&mut self, capturing: bool) {
        if capturing && self.hooks.is_none() {
            KEY_DOWNS.store(0, Ordering::Relaxed);
            MOUSE_EVENTS.store(0, Ordering::Relaxed);
            match HookThread::start() {
                Some((t, ok)) => {
                    if !ok {
                        log::warn!("could not install input hooks; activity counts unavailable");
                    }
                    self.hooks_ok = ok;
                    self.hooks = Some(t);
                }
                None => {
                    log::warn!("could not start the input hook thread");
                    self.hooks_ok = false;
                }
            }
        } else if !capturing {
            if let Some(t) = self.hooks.take() {
                t.stop();
            }
            self.hooks_ok = false;
            KEY_DOWNS.store(0, Ordering::Relaxed);
            MOUSE_EVENTS.store(0, Ordering::Relaxed);
        }
    }

    fn sample(&mut self) -> InputSample {
        let keyboard_count = KEY_DOWNS.swap(0, Ordering::Relaxed);
        let mouse_count = MOUSE_EVENTS.swap(0, Ordering::Relaxed);
        InputSample {
            keyboard_count,
            mouse_count,
            counts_available: self.hooks_ok,
            seconds_since_last_input: seconds_since_last_input(),
        }
    }
}

impl Drop for HookInputCounter {
    fn drop(&mut self) {
        if let Some(t) = self.hooks.take() {
            t.stop();
        }
    }
}

// ----- foreground app ---------------------------------------------------------------

/// Image path of the process owning the foreground window. Never reads the title.
fn foreground_image_path() -> Option<String> {
    // SAFETY: no arguments; may return null (secure desktop, no foreground window).
    let hwnd: HWND = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: `hwnd` came from GetForegroundWindow; `pid` is writable.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == 0 {
        return None;
    }
    // SAFETY: requesting the least-privileged query right; null on failure.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: `buf` holds `len` u16s; the call writes at most that many and updates
    // `len` to the characters written. The handle is closed right after.
    let ok = unsafe {
        let ok =
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        ok
    };
    if ok == 0 {
        return None;
    }
    let len = (len as usize).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `FileDescription` from the executable's version resource (e.g. "Visual Studio
/// Code"), if it has one.
fn file_description(path: &str) -> Option<String> {
    let wpath = wide(path);
    // SAFETY: `wpath` is NUL-terminated; the handle out-param may be null.
    let size = unsafe { GetFileVersionInfoSizeW(wpath.as_ptr(), null_mut()) };
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    // SAFETY: `data` has exactly `size` writable bytes.
    if unsafe { GetFileVersionInfoW(wpath.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let query = |sub: &str| -> Option<&[u16]> {
        let wsub = wide(sub);
        let mut ptr: *mut c_void = null_mut();
        let mut len = 0u32;
        // SAFETY: `data` is the version block filled above and outlives the returned
        // slice; VerQueryValueW returns a pointer *into* it and its length in u16s
        // (for strings) or bytes (for the translation table).
        let ok = unsafe { VerQueryValueW(data.as_ptr().cast(), wsub.as_ptr(), &mut ptr, &mut len) };
        if ok == 0 || ptr.is_null() || len == 0 {
            return None;
        }
        // SAFETY: see above; u16 alignment is guaranteed inside version resources.
        Some(unsafe { std::slice::from_raw_parts(ptr as *const u16, len as usize) })
    };
    let (lang, codepage) = query("\\VarFileInfo\\Translation")
        .filter(|t| t.len() >= 2)
        .map(|t| (t[0], t[1]))
        .unwrap_or((0x0409, 0x04B0));
    let desc = query(&format!(
        "\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription"
    ))?;
    let s = utf16_until_nul(desc).trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// Foreground application via the process image.
pub struct WinForeground {
    names: HashMap<String, String>,
}

impl WinForeground {
    /// Creates the source.
    pub fn new() -> Self {
        Self {
            names: HashMap::new(),
        }
    }
}

impl Default for WinForeground {
    fn default() -> Self {
        Self::new()
    }
}

impl ForegroundApp for WinForeground {
    fn current(&mut self) -> Option<ForegroundAppInfo> {
        let path = foreground_image_path()?;
        let identifier = file_name(&path).to_owned();
        if identifier.is_empty() {
            return None;
        }
        if self.names.len() > 512 {
            self.names.clear();
        }
        let name = self
            .names
            .entry(path.clone())
            .or_insert_with(|| {
                file_description(&path).unwrap_or_else(|| file_stem(&path).to_owned())
            })
            .clone();
        Some(ForegroundAppInfo {
            app_identifier: identifier,
            app_name: name,
        })
    }
}

// ----- screen capture ----------------------------------------------------------------

/// Releases GDI objects in reverse order of creation, on every exit path.
struct Gdi {
    screen: HDC,
    mem: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Drop for Gdi {
    fn drop(&mut self) {
        // SAFETY: each handle is either null (skipped) or was created by us below and
        // not yet released.
        unsafe {
            if !self.mem.is_null() && !self.previous.is_null() {
                SelectObject(self.mem, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.mem.is_null() {
                DeleteDC(self.mem);
            }
            if !self.screen.is_null() {
                ReleaseDC(null_mut(), self.screen);
            }
        }
    }
}

/// Captures the primary monitor with GDI.
pub struct GdiCapturer;

impl GdiCapturer {
    fn grab(max_width: u32) -> Result<RawFrame, CaptureError> {
        let fail = |what: &str| CaptureError::Failed(format!("{what} failed"));
        // SAFETY: no arguments.
        let (sw, sh) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        if sw <= 0 || sh <= 0 {
            return Err(fail("GetSystemMetrics"));
        }
        let (dw, dh) = scaled_size(sw as u32, sh as u32, max_width);
        let (dw, dh) = (dw as i32, dh as i32);
        let mut g = Gdi {
            screen: null_mut(),
            mem: null_mut(),
            bitmap: null_mut(),
            previous: null_mut(),
        };
        // SAFETY: standard GDI capture sequence; every handle is checked and owned by
        // `g`, which releases it on drop.
        unsafe {
            g.screen = GetDC(null_mut());
            if g.screen.is_null() {
                return Err(fail("GetDC"));
            }
            g.mem = CreateCompatibleDC(g.screen);
            if g.mem.is_null() {
                return Err(fail("CreateCompatibleDC"));
            }
            g.bitmap = CreateCompatibleBitmap(g.screen, dw, dh);
            if g.bitmap.is_null() {
                return Err(fail("CreateCompatibleBitmap"));
            }
            g.previous = SelectObject(g.mem, g.bitmap);
            let ok = if (dw, dh) == (sw, sh) {
                BitBlt(g.mem, 0, 0, dw, dh, g.screen, 0, 0, SRCCOPY)
            } else {
                SetStretchBltMode(g.mem, HALFTONE);
                SetBrushOrgEx(g.mem, 0, 0, null_mut());
                StretchBlt(g.mem, 0, 0, dw, dh, g.screen, 0, 0, sw, sh, SRCCOPY)
            };
            if ok == 0 {
                return Err(fail("BitBlt"));
            }
            // GetDIBits requires the bitmap not to be selected into a DC.
            SelectObject(g.mem, g.previous);
            g.previous = null_mut();
        }
        let mut info: BITMAPINFO = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: dw,
                biHeight: -dh, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default(); 1],
        };
        let mut buf = vec![0u8; dw as usize * dh as usize * 4];
        // SAFETY: `buf` holds dw*dh 32-bit pixels, exactly what a top-down 32 bpp DIB of
        // that size needs; `info` describes it.
        let lines = unsafe {
            GetDIBits(
                g.mem,
                g.bitmap,
                0,
                dh as u32,
                buf.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        drop(g);
        if lines != dh {
            return Err(fail("GetDIBits"));
        }
        bgra_to_rgba(&mut buf);
        Ok(RawFrame {
            width: dw as u32,
            height: dh as u32,
            rgba: buf,
        })
    }
}

impl ScreenCapturer for GdiCapturer {
    fn capture(&self, primary_monitor_only: bool) -> Result<RawFrame, CaptureError> {
        self.capture_scaled(primary_monitor_only, u32::MAX)
    }

    /// Always the primary monitor (`primary_monitor_only = false` is not implemented
    /// yet and falls back to it).
    fn capture_scaled(
        &self,
        _primary_monitor_only: bool,
        max_width: u32,
    ) -> Result<RawFrame, CaptureError> {
        Self::grab(max_width)
    }
}
