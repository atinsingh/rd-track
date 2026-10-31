//! The native messaging host for the Track browser extension (website domains, Pro).
//!
//! A browser starts the agent binary itself as the host when the extension connects:
//! Chromium browsers pass the extension's origin, Firefox the host manifest's path and
//! the extension's ID. [`host_family`] recognises those arguments, and [`run`] then
//! relays the extension's messages to `<data-dir>/browser/` (see
//! [`rd_agent_core::browser`]) until the browser closes the port. Nothing else of the
//! app starts.
//!
//! For browsers to find the host, a small manifest naming this executable is installed
//! for the current user in each browser's `NativeMessagingHosts` folder (the registry on
//! Windows) by [`install_manifests`]. Browsers that are not installed are skipped.

use std::io;
use std::path::{Path, PathBuf};

use rd_agent_core::browser::{self, Bridge, BrowserFamily, FIREFOX_EXTENSION_ID, HOST_NAME};
use serde_json::json;

/// The Chromium extension's ID, fixed by the public key in its manifest. Store builds
/// (Chrome Web Store, Edge Add-ons) get their own IDs, added at build time through
/// `RD_CHROMIUM_EXTENSION_IDS` (comma-separated).
pub const CHROMIUM_EXTENSION_ID: &str = "gagmoddppfppofnboknnmkiakhjmacln";

fn chromium_ids() -> Vec<&'static str> {
    let mut ids = vec![CHROMIUM_EXTENSION_ID];
    if let Some(extra) = option_env!("RD_CHROMIUM_EXTENSION_IDS") {
        ids.extend(extra.split(',').map(str::trim).filter(|s| !s.is_empty()));
    }
    ids
}

/// The browser family this process was started for as a native messaging host, if any.
pub fn host_family(args: &[String]) -> Option<BrowserFamily> {
    let family = BrowserFamily::of_host_args(args)?;
    // A Chromium origin must be one of ours (the browser checks too).
    if family == BrowserFamily::Chromium {
        let ok = args.iter().any(|a| {
            chromium_ids()
                .iter()
                .any(|id| a.trim_end_matches('/') == format!("chrome-extension://{id}"))
        });
        if !ok {
            return None;
        }
    }
    Some(family)
}

/// Runs the host on stdin/stdout until the browser closes the port.
pub fn run(data_dir: &Path, family: BrowserFamily) -> io::Result<()> {
    let bridge = Bridge::new(data_dir);
    let stdin = io::stdin();
    let stdout = io::stdout();
    browser::run_host(
        &bridge,
        family,
        &mut stdin.lock(),
        &mut stdout.lock(),
        chrono::Utc::now,
    )
}

/// Where one browser looks for host manifests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLocation {
    /// Which manifest it takes.
    pub family: BrowserFamily,
    /// The browser's own folder; it is installed when this exists.
    pub browser_dir: PathBuf,
    /// Where the manifest goes (inside or next to `browser_dir`).
    pub manifest_dir: PathBuf,
}

/// The user-level manifest folders of the supported browsers on macOS and Linux
/// (`config`: `$XDG_CONFIG_HOME`, default `~/.config`).
pub fn locations(home: &Path, config: Option<PathBuf>) -> Vec<HostLocation> {
    let at = |family, browser: PathBuf, manifest: PathBuf| HostLocation {
        family,
        browser_dir: browser,
        manifest_dir: manifest,
    };
    let chromium = |base: PathBuf| {
        at(
            BrowserFamily::Chromium,
            base.clone(),
            base.join("NativeMessagingHosts"),
        )
    };
    if cfg!(target_os = "macos") {
        let support = home.join("Library/Application Support");
        let mut v: Vec<_> = [
            "Google/Chrome",
            "Google/Chrome Beta",
            "Chromium",
            "Microsoft Edge",
            "BraveSoftware/Brave-Browser",
        ]
        .iter()
        .map(|b| chromium(support.join(b)))
        .collect();
        v.push(at(
            BrowserFamily::Firefox,
            support.join("Firefox"),
            support.join("Mozilla/NativeMessagingHosts"),
        ));
        v
    } else {
        let config = config.unwrap_or_else(|| home.join(".config"));
        let mut v: Vec<_> = [
            "google-chrome",
            "google-chrome-beta",
            "chromium",
            "microsoft-edge",
            "BraveSoftware/Brave-Browser",
        ]
        .iter()
        .map(|b| chromium(config.join(b)))
        .collect();
        v.push(at(
            BrowserFamily::Firefox,
            home.join(".mozilla"),
            home.join(".mozilla/native-messaging-hosts"),
        ));
        v
    }
}

/// The host manifest for `family`, naming `exe`.
pub fn manifest(family: BrowserFamily, exe: &Path) -> serde_json::Value {
    let mut m = json!({
        "name": HOST_NAME,
        "description": "RoundDigital Track: website domains for work sessions",
        "path": exe,
        "type": "stdio",
    });
    match family {
        BrowserFamily::Chromium => {
            let origins: Vec<String> = chromium_ids()
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect();
            m["allowed_origins"] = json!(origins);
        }
        BrowserFamily::Firefox => m["allowed_extensions"] = json!([FIREFOX_EXTENSION_ID]),
    }
    m
}

fn write_if_changed(path: &Path, value: &serde_json::Value) -> io::Result<bool> {
    let body = serde_json::to_vec_pretty(value)?;
    if std::fs::read(path).ok().as_deref() == Some(&body[..]) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, body)?;
    Ok(true)
}

/// Installs the host manifests for the current user, pointing at `exe`, for every
/// supported browser that is installed. Returns the manifests written or changed.
pub fn install_manifests(exe: &Path, data_dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    if cfg!(windows) {
        // One manifest per family in the data folder, registered for each browser.
        for family in BrowserFamily::ALL {
            let path = data_dir
                .join("browser")
                .join(format!("{HOST_NAME}.{}.json", family.name()));
            if write_if_changed(&path, &manifest(family, exe))? {
                written.push(path.clone());
            }
            let keys: &[&str] = match family {
                BrowserFamily::Chromium => &[
                    r"Software\Google\Chrome",
                    r"Software\Microsoft\Edge",
                    r"Software\Chromium",
                ],
                BrowserFamily::Firefox => &[r"Software\Mozilla"],
            };
            for k in keys {
                register_windows(
                    &format!(r"HKCU\{k}\NativeMessagingHosts\{HOST_NAME}"),
                    &path,
                );
            }
        }
        return Ok(written);
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(written);
    };
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    install_unix(exe, &locations(&home, config))
}

#[cfg_attr(windows, allow(dead_code))]
fn install_unix(exe: &Path, locations: &[HostLocation]) -> io::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for loc in locations {
        if !loc.browser_dir.is_dir() {
            continue;
        }
        let path = loc.manifest_dir.join(format!("{HOST_NAME}.json"));
        if write_if_changed(&path, &manifest(loc.family, exe))? {
            written.push(path);
        }
    }
    Ok(written)
}

#[cfg(windows)]
fn register_windows(key: &str, manifest: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("reg")
        .args(["add", key, "/ve", "/t", "REG_SZ", "/d"])
        .arg(manifest)
        .arg("/f")
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if !status.is_ok_and(|s| s.success()) {
        log::info!("browser host not registered under {key}");
    }
}

#[cfg(not(windows))]
fn register_windows(_key: &str, _manifest: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_only_our_extensions() {
        let ours = vec![
            format!("chrome-extension://{CHROMIUM_EXTENSION_ID}/"),
            "--parent-window=0".into(),
        ];
        assert_eq!(host_family(&ours), Some(BrowserFamily::Chromium));
        assert_eq!(
            host_family(&["chrome-extension://someoneelse/".into()]),
            None
        );
        assert_eq!(
            host_family(&[
                "/home/a/.mozilla/native-messaging-hosts/digital.round.track.json".into(),
                FIREFOX_EXTENSION_ID.into()
            ]),
            Some(BrowserFamily::Firefox)
        );
        assert_eq!(host_family(&["run".into()]), None);
    }

    #[test]
    fn manifests_name_the_extension_allowed_to_connect() {
        let m = manifest(
            BrowserFamily::Chromium,
            Path::new("/opt/track/rd-agent-desktop"),
        );
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["path"], "/opt/track/rd-agent-desktop");
        assert_eq!(
            m["allowed_origins"][0],
            format!("chrome-extension://{CHROMIUM_EXTENSION_ID}/")
        );
        assert!(m.get("allowed_extensions").is_none());
        let f = manifest(BrowserFamily::Firefox, Path::new("/x"));
        assert_eq!(f["allowed_extensions"], json!([FIREFOX_EXTENSION_ID]));
    }

    #[cfg(not(windows))]
    #[test]
    fn installs_for_the_browsers_that_are_there() {
        let home = tempfile::tempdir().unwrap();
        let locs = locations(home.path(), None);
        assert_eq!(
            locs.iter()
                .filter(|l| l.family == BrowserFamily::Firefox)
                .count(),
            1
        );
        // Only the first browser exists.
        std::fs::create_dir_all(&locs[0].browser_dir).unwrap();
        let exe = Path::new("/opt/track/bin");
        let first = install_unix(exe, &locs).unwrap();
        let again = install_unix(exe, &locs).unwrap();
        assert_eq!(
            first,
            [locs[0].manifest_dir.join("digital.round.track.json")]
        );
        assert!(again.is_empty(), "unchanged manifests are left alone");
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&first[0]).unwrap()).unwrap();
        assert_eq!(written["path"], "/opt/track/bin");
    }
}
