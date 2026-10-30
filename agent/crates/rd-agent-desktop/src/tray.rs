//! System tray / menu-bar icon: three states (idle, tracking, paused), a tooltip (and
//! on macOS a title with the elapsed time), left click toggles the popover, right
//! click (or any click on Linux) opens the menu.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rd_agent_core::events::StopReason;
use rd_agent_core::i18n::Lang;
use rd_agent_core::runtime::Command;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect};

use crate::controller::Controller;
use crate::view::{self, TrayState};

const TRAY_ID: &str = "rd-track";

/// When the popover last hid because it lost focus (ms since the epoch). Clicking the
/// tray icon while the popover is open first blurs it; without this the same click
/// would immediately show it again.
static LAST_BLUR_HIDE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Records a hide caused by focus loss.
pub fn note_blur_hide() {
    LAST_BLUR_HIDE_MS.store(now_ms(), Ordering::Relaxed);
}

fn icon(state: TrayState) -> Option<Image<'static>> {
    let bytes: &'static [u8] = match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayState::Tracking => include_bytes!("../icons/tray-tracking.png"),
        TrayState::Paused => include_bytes!("../icons/tray-paused.png"),
    };
    Image::from_bytes(bytes).ok()
}

/// The tray menu in `lang`.
fn menu(app: &AppHandle, lang: Lang) -> tauri::Result<Menu<tauri::Wry>> {
    let m = lang.messages();
    let open = MenuItem::with_id(app, "open", m.menu_open, true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", m.menu_pause, true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", m.menu_stop, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", m.menu_quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &stop, &sep, &quit])
}

/// Rewrites the tray menu after the language changed.
pub fn relabel(app: &AppHandle, lang: Lang) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), menu(app, lang)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Creates the tray icon and its menu.
pub fn create(app: &AppHandle, lang: Lang) -> tauri::Result<()> {
    let menu = menu(app, lang)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("RoundDigital Track")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_centered(app),
            "pause" => {
                let ctl = app.state::<Arc<Controller>>();
                let cmd = if ctl.view().tray == TrayState::Paused {
                    Command::Resume
                } else {
                    Command::Pause
                };
                let _ = ctl.send(cmd);
            }
            "stop" => {
                let _ = app
                    .state::<Arc<Controller>>()
                    .send(Command::Stop(StopReason::User));
            }
            "quit" => crate::quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_at(tray.app_handle(), rect);
            }
        });
    if let Some(i) = icon(TrayState::Idle) {
        builder = builder.icon(i);
    }
    builder.build(app)?;
    Ok(())
}

/// Updates icon, tooltip and (macOS) title.
pub fn update(app: &AppHandle, state: TrayState, tooltip: &str, title: Option<&str>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Some(i) = icon(state) {
        let _ = tray.set_icon(Some(i));
    }
    let _ = tray.set_tooltip(Some(tooltip));
    if cfg!(target_os = "macos") {
        let _ = tray.set_title(title);
    }
}

/// Shows the popover centred on screen (menu "Open", first run, Linux).
pub fn show_centered(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Shows the popover for the idle-return prompt: under (or above) the tray icon when
/// its position is known, else centred. It does not take focus, so keys the person is
/// typing as they come back stay in their own app (and cannot pick a choice).
pub fn show_for_prompt(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        return;
    }
    match app
        .tray_by_id(TRAY_ID)
        .and_then(|t| t.rect().ok().flatten())
    {
        Some(rect) => place_at(app, &w, rect),
        None => {
            let _ = w.center();
        }
    }
    let _ = w.show();
}

fn toggle_at(app: &AppHandle, rect: Rect) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    if now_ms().saturating_sub(LAST_BLUR_HIDE_MS.load(Ordering::Relaxed)) < 300 {
        return;
    }
    place_at(app, &w, rect);
    let _ = w.show();
    let _ = w.set_focus();
}

/// Positions the popover next to the tray icon at `rect`.
fn place_at(app: &AppHandle, w: &tauri::WebviewWindow, rect: Rect) {
    let scale = w.scale_factor().unwrap_or(1.0);
    let pos = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let win = w.outer_size().unwrap_or_default();
    let area = app
        .monitor_from_point(pos.x, pos.y)
        .ok()
        .flatten()
        .map(|m| {
            let a = m.work_area();
            (
                f64::from(a.position.x),
                f64::from(a.position.y),
                f64::from(a.size.width),
                f64::from(a.size.height),
            )
        });
    match area {
        Some(area) => {
            let (x, y) = view::popover_origin(
                (pos.x, pos.y, size.width, size.height),
                (f64::from(win.width), f64::from(win.height)),
                area,
            );
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        None => {
            let _ = w.center();
        }
    }
}
