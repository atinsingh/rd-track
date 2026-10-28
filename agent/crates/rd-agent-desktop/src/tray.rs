//! System tray / menu-bar icon: three states (idle, tracking, paused), a tooltip (and
//! on macOS a title with the elapsed time), left click toggles the popover, right
//! click (or any click on Linux) opens the menu.

use std::sync::Arc;

use rd_agent_core::events::StopReason;
use rd_agent_core::runtime::Command;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect};

use crate::controller::Controller;
use crate::view::{self, TrayState};

const TRAY_ID: &str = "rd-track";

fn icon(state: TrayState) -> Option<Image<'static>> {
    let bytes: &'static [u8] = match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayState::Tracking => include_bytes!("../icons/tray-tracking.png"),
        TrayState::Paused => include_bytes!("../icons/tray-paused.png"),
    };
    Image::from_bytes(bytes).ok()
}

/// Creates the tray icon and its menu.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open RoundDigital Track", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / resume", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop session", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit (stops the session)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &stop, &sep, &quit])?;
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

fn toggle_at(app: &AppHandle, rect: Rect) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
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
    let _ = w.show();
    let _ = w.set_focus();
}
