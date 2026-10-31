//! `rdtrack://enroll?server=…&code=…` links from the web app's "Connect this computer"
//! page (slice 4c, G12). A link only fills in the sign-in form; the person still checks
//! the server address and presses Connect, so a link from anywhere else can't enrol this
//! computer on its own.

use serde::Serialize;
use tauri::Url;

/// What an enrolment link fills in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnrollPrefill {
    /// Server address, already checked like a typed one.
    pub server_url: String,
    /// One-time enrolment code.
    pub code: String,
}

/// The same rule as a typed server address: https, or http on this computer for development.
pub fn acceptable_server(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1")
}

/// Parses an enrolment link; anything else (another scheme, path or a bad value) is `None`.
pub fn parse_enroll_link(raw: &str) -> Option<EnrollPrefill> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "rdtrack" || url.host_str() != Some("enroll") {
        return None;
    }
    let mut server = None;
    let mut code = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "server" => server = Some(v.trim().trim_end_matches('/').to_owned()),
            "code" => code = Some(v.trim().to_owned()),
            _ => {}
        }
    }
    let server_url = server.filter(|s| acceptable_server(s) && s.len() <= 2000)?;
    let code = code.filter(|c| {
        !c.is_empty()
            && c.len() <= 64
            && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })?;
    Some(EnrollPrefill { server_url, code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_in_server_and_code_from_a_link() {
        assert_eq!(
            parse_enroll_link(
                "rdtrack://enroll?server=https%3A%2F%2Ftrack.acme.com%2F&code=ABCD-EFGH"
            ),
            Some(EnrollPrefill {
                server_url: "https://track.acme.com".into(),
                code: "ABCD-EFGH".into()
            })
        );
        assert_eq!(
            parse_enroll_link(" rdtrack://enroll?code=X1&server=http://localhost:3000 ")
                .map(|p| p.server_url),
            Some("http://localhost:3000".into())
        );
    }

    #[test]
    fn ignores_anything_else() {
        for bad in [
            "https://track.acme.com/enroll?server=https://x&code=A",
            "rdtrack://open?server=https://x&code=A",
            "rdtrack://enroll?server=http://evil.example&code=A",
            "rdtrack://enroll?server=https://x",
            "rdtrack://enroll?server=https://x&code=<script>",
            "not a url",
        ] {
            assert_eq!(parse_enroll_link(bad), None, "{bad}");
        }
    }
}
