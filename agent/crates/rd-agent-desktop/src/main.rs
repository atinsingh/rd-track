//! RoundDigital Track tray app (Tauri 2).
//!
//! The agent runtime from `rd-agent-core` runs on its own tick thread with the native
//! collectors (simulated on Linux). The popover (`ui/`) talks to it only through the
//! commands below, each individually allowed in `capabilities/main.json`; it has no
//! filesystem, shell, HTTP or opener access of its own.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod controller;
mod link;
mod tray;
mod updates;
mod view;

use std::sync::Arc;

use rd_agent_core::events::StopReason;
use rd_agent_core::runtime::Command;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Updater, UpdaterExt};

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
    if !link::acceptable_server(&server_url) {
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

/// On a computer IT deployed (G26): emails the person a one-time code.
#[tauri::command]
async fn request_email_code(ctl: State<'_, Arc<Controller>>, email: String) -> Result<(), String> {
    let ctl = ctl.inner().clone();
    blocking(move || ctl.request_email_code(&email)).await
}

#[tauri::command]
fn reenroll(app: AppHandle, ctl: Ctl<'_>) -> AppView {
    ctl.reenroll();
    ctl.emit(&app);
    ctl.view()
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = updater_for(&app)?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    install(&app, update).await
}

/// The updater for this computer's server, asking with its device credential (G10).
fn updater_for(app: &AppHandle) -> Result<Updater, String> {
    let (server, credential) = app
        .state::<Arc<Controller>>()
        .update_source()
        .ok_or("this computer isn't connected yet")?;
    let url = tauri::Url::parse(&updates::endpoint(&server)).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Authorization", format!("Device {credential}"))
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// Downloads first, then stops the session cleanly (final sync) and lets the installer
/// replace the app. A failed download leaves everything running.
async fn install(app: &AppHandle, update: tauri_plugin_updater::Update) -> Result<(), String> {
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let ctl = app.state::<Arc<Controller>>().inner().clone();
    blocking(move || {
        ctl.shutdown();
        Ok(())
    })
    .await?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

/// Open at login (G10): off until the person turns it on. It only opens the app in the
/// menu bar or tray; nothing is collected until they start a session.
#[tauri::command]
fn get_open_at_login(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    }
    .map_err(|e| e.to_string())?;
    launcher.is_enabled().map_err(|e| e.to_string())
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

/// Asks for updates a minute after start and then hourly (release builds only). The
/// organization decides: offer it to the person, install it between sessions, or hold.
fn check_for_updates(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        loop {
            tauri::async_runtime::block_on(check_once(&app));
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });
}

async fn check_once(app: &AppHandle) {
    let Ok(updater) = updater_for(app) else {
        return;
    };
    let ctl = app.state::<Arc<Controller>>().inner().clone();
    match updater.check().await {
        Ok(Some(u)) => {
            if updates::apply(&u.raw_json, ctl.no_open_session()) == updates::Apply::Install {
                log::info!("installing version {} between sessions", u.version);
                let version = u.version.clone();
                if let Err(e) = install(app, u).await {
                    log::info!("automatic update failed: {e}");
                    ctl.set_update(Some(version));
                    ctl.emit(app);
                }
                return;
            }
            ctl.set_update(Some(u.version.clone()));
            ctl.emit(app);
        }
        // Nothing to install, or held by the organization: no banner.
        Ok(None) => {
            ctl.set_update(None);
            ctl.emit(app);
        }
        Err(e) => log::info!("update check skipped: {e}"),
    }
}

/// An `rdtrack://enroll` link (from the web app, or forwarded by a second launch) fills in
/// the sign-in form and shows the window. Nothing is enrolled until the person presses Connect.
fn open_link(app: &AppHandle, raw: &str) {
    let Some(prefill) = link::parse_enroll_link(raw) else {
        return;
    };
    let ctl = app.state::<Arc<Controller>>();
    if ctl.set_enroll_prefill(prefill) {
        ctl.emit(app);
        tray::show_centered(app);
    } else {
        log::info!("enrolment link ignored: this computer is already connected");
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_target(false)
        .init();
    let ctl = Controller::new();
    let app = tauri::Builder::default()
        // First, so a second launch (e.g. opening an enrolment link on Windows or Linux)
        // hands its arguments to the running tray app instead of starting another one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv.iter().skip(1) {
                open_link(app, arg);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
            request_email_code,
            install_update,
            get_open_at_login,
            set_open_at_login,
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
            // Development builds on Windows and Linux register the scheme at run time;
            // installers register it themselves.
            #[cfg(any(windows, target_os = "linux"))]
            if let Err(e) = app.deep_link().register_all() {
                log::info!("link scheme not registered: {e}");
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open_link(&handle, url.as_str());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    open_link(app.handle(), url.as_str());
                }
            }
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
