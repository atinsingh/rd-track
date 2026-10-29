//! RoundDigital Track tray app (Tauri 2).
//!
//! The agent runtime from `rd-agent-core` runs on its own tick thread with the native
//! collectors (simulated on Linux). The popover (`ui/`) talks to it only through the
//! commands below, each individually allowed in `capabilities/main.json`; it has no
//! filesystem, shell, HTTP or opener access of its own.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod controller;
mod tray;
mod view;

use std::sync::Arc;

use rd_agent_core::events::StopReason;
use rd_agent_core::runtime::Command;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use controller::{AppView, Controller};
use view::{RemindersInput, SessionNotice};

type Ctl<'a> = State<'a, Arc<Controller>>;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_view(ctl: Ctl<'_>) -> AppView {
    ctl.view()
}

#[tauri::command]
async fn enroll(
    app: AppHandle,
    ctl: Ctl<'_>,
    server_url: String,
    code: String,
    device_name: Option<String>,
) -> Result<AppView, String> {
    let server_url = server_url.trim().to_owned();
    if !(server_url.starts_with("https://")
        || server_url.starts_with("http://localhost")
        || server_url.starts_with("http://127.0.0.1"))
    {
        return Err("Enter the server address starting with https://".into());
    }
    let c = ctl.inner().clone();
    let a = app.clone();
    blocking(move || {
        c.enroll(
            a,
            &server_url,
            &code,
            device_name.filter(|n| !n.trim().is_empty()),
        )
    })
    .await?;
    Ok(ctl.view())
}

#[tauri::command]
async fn list_projects(ctl: Ctl<'_>) -> Result<AppView, String> {
    let c = ctl.inner().clone();
    blocking(move || c.refresh_projects()).await?;
    Ok(ctl.view())
}

#[tauri::command]
async fn prepare_session(
    ctl: Ctl<'_>,
    project_id: Option<String>,
    task_id: Option<String>,
) -> Result<SessionNotice, String> {
    let c = ctl.inner().clone();
    blocking(move || c.prepare(project_id, task_id)).await
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    ctl: Ctl<'_>,
    project_id: Option<String>,
    task_id: Option<String>,
) -> Result<AppView, String> {
    let c = ctl.inner().clone();
    blocking(move || c.start(project_id, task_id)).await?;
    ctl.emit(&app);
    Ok(ctl.view())
}

#[tauri::command]
fn review_collection(ctl: Ctl<'_>) -> Result<SessionNotice, String> {
    ctl.review()
}

#[tauri::command]
fn pause_session(ctl: Ctl<'_>) -> Result<(), String> {
    ctl.send(Command::Pause)
}

#[tauri::command]
fn resume_session(ctl: Ctl<'_>) -> Result<(), String> {
    ctl.send(Command::Resume)
}

#[tauri::command]
fn stop_session(ctl: Ctl<'_>) -> Result<(), String> {
    ctl.send(Command::Stop(StopReason::User))
}

/// The person's answer to the idle-return prompt. Only the popover calls this, on the
/// person's click; nothing decides for them.
#[tauri::command]
async fn resolve_idle(
    app: AppHandle,
    ctl: Ctl<'_>,
    id: String,
    decision: String,
    project_id: Option<String>,
    task_id: Option<String>,
) -> Result<AppView, String> {
    let c = ctl.inner().clone();
    blocking(move || c.resolve_idle(&id, &decision, project_id, task_id)).await?;
    ctl.emit(&app);
    Ok(ctl.view())
}

/// The person's answer to a start / stop / "still tracking?" reminder. Only the
/// popover calls this, on the person's click.
#[tauri::command]
async fn resolve_reminder(
    app: AppHandle,
    ctl: Ctl<'_>,
    id: String,
    choice: String,
) -> Result<AppView, String> {
    let c = ctl.inner().clone();
    blocking(move || c.resolve_reminder(&id, &choice)).await?;
    ctl.emit(&app);
    Ok(ctl.view())
}

/// The employee's reminder settings (kept on this computer only).
#[tauri::command]
async fn set_reminder_settings(
    app: AppHandle,
    ctl: Ctl<'_>,
    settings: RemindersInput,
) -> Result<AppView, String> {
    let c = ctl.inner().clone();
    blocking(move || c.set_reminders(&settings)).await?;
    ctl.emit(&app);
    Ok(ctl.view())
}

#[tauri::command]
fn dismiss_banner(app: AppHandle, ctl: Ctl<'_>, id: String) {
    ctl.dismiss(&id);
    ctl.emit(&app);
}

#[tauri::command]
fn open_dashboard(app: AppHandle, ctl: Ctl<'_>) -> Result<(), String> {
    let url = ctl
        .dashboard_url()
        .ok_or("no dashboard address is known yet")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_permission_settings(app: AppHandle, name: String) -> Result<(), String> {
    let url = Controller::permission_settings_url(&name)
        .ok_or("this permission has no settings page on this system")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn request_permission(app: AppHandle, ctl: Ctl<'_>, name: String) -> Result<bool, String> {
    let asked = ctl.request_permission(&name)?;
    if !asked {
        // Already asked once on this install: only ever link to System Settings.
        open_permission_settings(app.clone(), name)?;
    }
    ctl.emit(&app);
    Ok(asked)
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit(app);
}

#[tauri::command]
fn reenroll(app: AppHandle, ctl: Ctl<'_>) -> AppView {
    ctl.reenroll();
    ctl.emit(&app);
    ctl.view()
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    // Stop the session cleanly before the installer replaces the binary.
    let ctl = app.state::<Arc<Controller>>().inner().clone();
    blocking(move || {
        ctl.shutdown();
        Ok(())
    })
    .await?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// Quit: stop the session first (bounded final sync), then exit.
pub(crate) fn quit(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let ctl = app.state::<Arc<Controller>>().inner().clone();
    std::thread::spawn(move || {
        ctl.shutdown();
        app.exit(0);
    });
}

/// Background update check (release builds with a configured updater key only).
fn check_for_updates(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else {
            return;
        };
        match updater.check().await {
            Ok(Some(u)) => {
                let ctl = app.state::<Arc<Controller>>();
                ctl.set_update(Some(u.version.clone()));
                ctl.emit(&app);
            }
            Ok(None) => {}
            Err(e) => log::info!("update check skipped: {e}"),
        }
    });
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_target(false)
        .init();
    let ctl = Controller::new();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ctl.clone())
        .invoke_handler(tauri::generate_handler![
            get_view,
            enroll,
            list_projects,
            prepare_session,
            start_session,
            review_collection,
            pause_session,
            resume_session,
            stop_session,
            resolve_idle,
            resolve_reminder,
            set_reminder_settings,
            dismiss_banner,
            open_dashboard,
            open_permission_settings,
            request_permission,
            hide_window,
            quit_app,
            reenroll,
            install_update,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::create(app.handle())?;
            let needs_ui = ctl.boot(app.handle());
            // Linux trays cannot report clicks: open the window on start there too.
            if needs_ui || cfg!(target_os = "linux") {
                tray::show_centered(app.handle());
            }
            ctl.emit(app.handle());
            check_for_updates(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // The popover hides instead of closing; the app lives in the tray.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(false)
                if !cfg!(target_os = "linux") && window.is_visible().unwrap_or(false) =>
            {
                tray::note_blur_hide();
                let _ = window.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build the tray app");
    app.run(|app, event| match event {
        // Closing the popover must not end the app; only Quit (which calls exit) does.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        // OS logout/shutdown: stop the session before the process goes away.
        RunEvent::Exit => {
            app.state::<Arc<Controller>>().shutdown();
        }
        _ => {}
    });
}
