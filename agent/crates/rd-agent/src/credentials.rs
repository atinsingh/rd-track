//! Credential stores.
//!
//! * [`FileCredentialStore`] (default, development): one file per secret in
//!   `<data-dir>/secrets/`, directory `0700`, files `0600`, written atomically.
//! * [`KeychainCredentialStore`] (feature `keychain`): the OS keychain via the `keyring`
//!   crate — Windows Credential Manager, macOS Keychain, Linux kernel keyutils.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use rd_agent_core::platform::{CredentialError, CredentialStore};

fn valid_name(name: &str) -> Result<(), CredentialError> {
    if !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        Ok(())
    } else {
        Err(CredentialError(format!("invalid secret name {name:?}")))
    }
}

fn err(e: impl std::fmt::Display) -> CredentialError {
    CredentialError(e.to_string())
}

/// File-backed credential store for development and CI.
#[derive(Debug, Clone)]
pub struct FileCredentialStore {
    dir: PathBuf,
}

impl FileCredentialStore {
    /// A store in `dir` (created with `0700` on first write).
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, name: &str) -> Result<PathBuf, CredentialError> {
        valid_name(name)?;
        Ok(self.dir.join(name))
    }

    fn ensure_dir(&self) -> Result<(), CredentialError> {
        fs::create_dir_all(&self.dir).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700)).map_err(err)?;
        }
        Ok(())
    }
}

impl CredentialStore for FileCredentialStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        match fs::read(self.path(name)?) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), CredentialError> {
        let path = self.path(name)?;
        self.ensure_dir()?;
        let tmp = path.with_extension("tmp");
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(err)?;
        f.write_all(value).map_err(err)?;
        f.sync_all().map_err(err)?;
        drop(f);
        fs::rename(&tmp, &path).map_err(err)
    }

    fn delete(&self, name: &str) -> Result<(), CredentialError> {
        match fs::remove_file(self.path(name)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}

/// OS keychain store (feature `keychain`).
#[cfg(feature = "keychain")]
#[derive(Debug, Clone)]
pub struct KeychainCredentialStore {
    service: String,
}

#[cfg(feature = "keychain")]
impl KeychainCredentialStore {
    /// A store under the given service name (one per data directory).
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry, CredentialError> {
        valid_name(name)?;
        keyring::Entry::new(&self.service, name).map_err(err)
    }
}

#[cfg(feature = "keychain")]
impl CredentialStore for KeychainCredentialStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        match self.entry(name)?.get_secret() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), CredentialError> {
        self.entry(name)?.set_secret(value).map_err(err)
    }

    fn delete(&self, name: &str) -> Result<(), CredentialError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_round_trip_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileCredentialStore::new(dir.path().join("secrets"));
        assert_eq!(store.get("device_credential").unwrap(), None);
        store.set("device_credential", b"abc").unwrap();
        store.set("device_credential", b"xyz").unwrap();
        assert_eq!(
            store.get("device_credential").unwrap(),
            Some(b"xyz".to_vec())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &std::path::Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir.path().join("secrets/device_credential")), 0o600);
            assert_eq!(mode(&dir.path().join("secrets")), 0o700);
        }
        store.delete("device_credential").unwrap();
        store.delete("device_credential").unwrap();
        assert_eq!(store.get("device_credential").unwrap(), None);
        assert!(store.set("../escape", b"x").is_err());
    }
}
