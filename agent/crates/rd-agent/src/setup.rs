//! Opening the agent's local state and enrolling a device — shared by the CLI and the
//! tray app so both behave identically.

use std::sync::{Arc, Mutex};

use rd_agent_core::api::{ApiClient, EnrollRequest, Os};
use rd_agent_core::identity::DeviceIdentity;
use rd_agent_core::outbox::{CredentialStoreKey, Outbox, OutboxConfig, SharedOutbox};
use rd_agent_core::platform::{secret_names, CredentialStore};
use rd_agent_core::policy::decode_b64;

use crate::config::{self, Paths};
use crate::{credentials, http};

/// The credential store: the OS keychain when built with feature `keychain` (unless
/// `RD_AGENT_CREDENTIAL_STORE=file`), otherwise `0600` files under the data directory.
pub fn credential_store(paths: &Paths) -> Arc<dyn CredentialStore> {
    #[cfg(feature = "keychain")]
    if std::env::var("RD_AGENT_CREDENTIAL_STORE").as_deref() != Ok("file") {
        return Arc::new(credentials::KeychainCredentialStore::new(format!(
            "rd-agent:{}",
            paths.root.display()
        )));
    }
    Arc::new(credentials::FileCredentialStore::new(paths.secrets()))
}

/// Opens (creating if needed) the encrypted outbox.
pub fn open_outbox(paths: &Paths, creds: &dyn CredentialStore) -> Result<SharedOutbox, String> {
    let outbox = Outbox::open(
        &paths.outbox(),
        &CredentialStoreKey(creds),
        OutboxConfig::default(),
    )
    .map_err(|e| format!("cannot open outbox: {e}"))?;
    Ok(Arc::new(Mutex::new(outbox)))
}

/// Whether this device is enrolled (identity present, not revoked, credential stored).
pub fn is_enrolled(paths: &Paths, creds: &dyn CredentialStore) -> Result<bool, String> {
    let identity = config::load_identity(&paths.identity())?;
    let has_credential = creds
        .get(secret_names::DEVICE_CREDENTIAL)
        .map_err(|e| e.to_string())?
        .is_some();
    Ok(identity.is_some_and(|i| !i.revoked) && has_credential)
}

/// Enrolls this device with a one-time code. A new enrollment is a new device: the
/// outbox is wiped and a new outbox key generated.
pub fn enroll(
    paths: &Paths,
    creds: &dyn CredentialStore,
    server: &str,
    code: &str,
    device_name: Option<String>,
    force: bool,
) -> Result<DeviceIdentity, String> {
    paths
        .ensure()
        .map_err(|e| format!("cannot create {}: {e}", paths.root.display()))?;
    if is_enrolled(paths, creds)? && !force {
        return Err("this device is already enrolled (use --force to re-enroll)".into());
    }
    let api = ApiClient::new(server, Arc::new(http::UreqTransport::new()));
    let resp = api
        .enroll(&EnrollRequest {
            enrollment_code: code.trim().to_owned(),
            device_name: device_name.unwrap_or_else(config::host_name),
            os: Os::current(),
            os_version: config::os_version(),
            agent_version: rd_agent_core::AGENT_VERSION.to_owned(),
        })
        .map_err(|e| format!("enrollment failed: {e}"))?;
    let key_ok = decode_b64(&resp.policy_signing_key.public_key_b64).is_some_and(|k| k.len() == 32);
    if !key_ok {
        return Err("enrollment response has an invalid policy signing key".into());
    }
    if paths.outbox().exists() {
        let outbox = open_outbox(paths, creds)?;
        rd_agent_core::outbox::lock(&outbox)
            .wipe()
            .map_err(|e| e.to_string())?;
    }
    creds
        .delete(secret_names::OUTBOX_KEY)
        .map_err(|e| e.to_string())?;
    creds
        .set(
            secret_names::DEVICE_CREDENTIAL,
            resp.device_credential.as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    let identity = DeviceIdentity {
        server_url: api.base_url().to_owned(),
        device_id: resp.device_id,
        user_id: resp.user_id,
        organization_id: resp.organization_id,
        policy_signing_key: resp.policy_signing_key,
        revoked: false,
        dashboard_url: resp.dashboard_url,
    };
    config::save_identity(&paths.identity(), &identity)?;
    Ok(identity)
}

/// Loads the identity and device credential needed to run, with employee-facing
/// errors.
pub fn load_for_run(
    paths: &Paths,
    creds: &dyn CredentialStore,
) -> Result<(DeviceIdentity, String), String> {
    let identity = config::load_identity(&paths.identity())?
        .ok_or("this device is not enrolled; run `rd-agent enroll` first")?;
    if identity.revoked {
        return Err(
            "this device was revoked; ask your administrator for a new enrollment code".into(),
        );
    }
    let credential = creds
        .get(secret_names::DEVICE_CREDENTIAL)
        .map_err(|e| e.to_string())?
        .ok_or("device credential is missing; re-enroll this device")?;
    let credential = String::from_utf8(credential).map_err(|_| "device credential is corrupt")?;
    Ok((identity, credential))
}

/// Marks the identity revoked after the runtime reported revocation.
pub fn mark_revoked(paths: &Paths, identity: &DeviceIdentity) -> Result<(), String> {
    let mut identity = identity.clone();
    identity.revoked = true;
    config::save_identity(&paths.identity(), &identity)
}
