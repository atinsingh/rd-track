//! App updates (G10). The app asks its own server, with its device credential, so each
//! organization decides how updates arrive (`GET /v1/device/update`). Whatever the
//! server says, only bundles signed with the key built into the app are installed.

/// The update endpoint on the enrolled server. The updater fills in the placeholders.
pub fn endpoint(server_url: &str) -> String {
    format!(
        "{}/v1/device/update?target={{{{target}}}}&arch={{{{arch}}}}&current_version={{{{current_version}}}}",
        server_url.trim_end_matches('/')
    )
}

/// What to do with an update the server offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Apply {
    /// Install it now: the organization installs updates automatically and no session is open.
    Install,
    /// Tell the person it is ready; they restart when it suits them.
    Offer,
}

/// Decides from the server's `mode` and whether a session is open. A running session is
/// never interrupted: an automatic update waits for the next check after it stops.
pub fn apply(raw: &serde_json::Value, no_open_session: bool) -> Apply {
    let automatic = raw.get("mode").and_then(|m| m.as_str()) == Some("auto");
    if automatic && no_open_session {
        Apply::Install
    } else {
        Apply::Offer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn endpoint_keeps_the_updater_placeholders() {
        assert_eq!(
            endpoint("https://track.example.com/"),
            "https://track.example.com/v1/device/update?target={{target}}&arch={{arch}}&current_version={{current_version}}"
        );
    }

    #[test]
    fn installs_automatically_only_between_sessions() {
        assert_eq!(apply(&json!({ "mode": "auto" }), true), Apply::Install);
        assert_eq!(apply(&json!({ "mode": "auto" }), false), Apply::Offer);
        assert_eq!(apply(&json!({ "mode": "prompt" }), true), Apply::Offer);
        assert_eq!(apply(&json!({}), true), Apply::Offer);
    }
}
