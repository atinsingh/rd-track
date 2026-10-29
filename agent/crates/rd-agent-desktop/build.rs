//! Generates the Tauri context and the permission set for the app's own commands
//! (each command gets an `allow-<name>` permission; `capabilities/main.json` grants
//! exactly the ones the popover uses).

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&COMMANDS)),
    )
    .expect("tauri build script failed");
}

/// Must match `generate_handler!` in `src/main.rs`.
const COMMANDS: [&str; 20] = [
    "get_view",
    "enroll",
    "list_projects",
    "prepare_session",
    "start_session",
    "review_collection",
    "pause_session",
    "resume_session",
    "stop_session",
    "resolve_idle",
    "resolve_reminder",
    "set_reminder_settings",
    "dismiss_banner",
    "open_dashboard",
    "open_permission_settings",
    "request_permission",
    "hide_window",
    "quit_app",
    "reenroll",
    "install_update",
];
