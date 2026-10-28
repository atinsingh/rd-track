//! Data directory layout and the persisted device identity.
//!
//! ```text
//! <data-dir>/
//!   device.json     enrollment data (non-secret), 0600
//!   outbox.db       encrypted outbox + policy cache (SQLite, WAL)
//!   secrets/        file credential store (dev): device_credential, outbox_key
//! ```

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rd_agent_core::identity::DeviceIdentity;

/// Resolves the data directory: `--data-dir`, then `RD_AGENT_DATA_DIR`, then the
/// platform default.
pub fn data_dir(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(p) = explicit {
        return p;
    }
    if let Some(p) = std::env::var_os("RD_AGENT_DATA_DIR") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("RoundDigital Track");
        }
    } else if cfg!(target_os = "macos") {
        if let Some(h) = &home {
            return h.join("Library/Application Support/RoundDigital Track");
        }
    } else {
        if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(x).join("rd-agent");
        }
        if let Some(h) = &home {
            return h.join(".local/share/rd-agent");
        }
    }
    PathBuf::from(".rd-agent")
}

/// Files inside the data directory.
#[derive(Debug, Clone)]
pub struct Paths {
    /// The directory itself.
    pub root: PathBuf,
}

impl Paths {
    /// Layout under `root`.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    /// `device.json`
    pub fn identity(&self) -> PathBuf {
        self.root.join("device.json")
    }
    /// `outbox.db`
    pub fn outbox(&self) -> PathBuf {
        self.root.join("outbox.db")
    }
    /// `secrets/`
    pub fn secrets(&self) -> PathBuf {
        self.root.join("secrets")
    }
    /// Creates the directory (`0700` on Unix).
    pub fn ensure(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

/// Loads `device.json`, if present.
pub fn load_identity(path: &Path) -> Result<Option<DeviceIdentity>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("{} is corrupt: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Writes `device.json` atomically with `0600` permissions.
pub fn save_identity(path: &Path, id: &DeviceIdentity) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(id).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(&json).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Best-effort host name for enrollment.
pub fn host_name() -> String {
    for var in ["RD_AGENT_DEVICE_NAME", "COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return v.trim().to_owned();
            }
        }
    }
    fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "rd-agent device".to_owned())
}

/// Best-effort OS version string.
pub fn os_version() -> String {
    if let Ok(s) = fs::read_to_string("/etc/os-release") {
        for line in s.lines() {
            if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                return v.trim_matches('"').to_owned();
            }
        }
    }
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rd_agent_core::policy::PinnedKey;

    #[test]
    fn identity_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path().join("data"));
        p.ensure().unwrap();
        assert_eq!(load_identity(&p.identity()).unwrap(), None);
        let id = DeviceIdentity {
            server_url: "http://localhost:3000".into(),
            device_id: "d".into(),
            user_id: "u".into(),
            organization_id: "o".into(),
            policy_signing_key: PinnedKey {
                key_id: "k".into(),
                public_key_b64: "AA==".into(),
            },
            revoked: false,
        };
        save_identity(&p.identity(), &id).unwrap();
        assert_eq!(load_identity(&p.identity()).unwrap(), Some(id));
        assert_eq!(data_dir(Some("/x".into())), PathBuf::from("/x"));
    }
}
