//! Device identity persisted after enrollment.

use serde::{Deserialize, Serialize};

use crate::policy::PinnedKey;

/// Non-secret enrollment data (the credential itself lives in the
/// [`CredentialStore`](crate::platform::CredentialStore)).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceIdentity {
    /// Server base URL.
    pub server_url: String,
    /// Device id.
    pub device_id: String,
    /// User id.
    pub user_id: String,
    /// Organization id.
    pub organization_id: String,
    /// Pinned policy signing key.
    pub policy_signing_key: PinnedKey,
    /// Set when the server revoked the device; the credential has been wiped.
    #[serde(default)]
    pub revoked: bool,
}
