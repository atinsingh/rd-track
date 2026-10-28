//! Blocking HTTP transport on `ureq` (rustls + webpki roots).
//!
//! Proxies come from the environment the way curl does it: `HTTPS_PROXY` for `https://`
//! URLs, `HTTP_PROXY` for `http://`, `ALL_PROXY` as a fallback, and `NO_PROXY`
//! (host names, `.suffix` domains, exact IPs, `*`) to bypass. Loopback hosts are always
//! reached directly.

use std::io::Read;
use std::time::Duration;

use rd_agent_core::platform::{HttpRequest, HttpResponse, HttpTransport, Method, TransportError};

/// Responses larger than this are truncated (the agent never expects big bodies).
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

fn env_any(names: &[&str]) -> Option<String> {
    names
        .iter()
        .filter_map(|n| std::env::var(n).ok())
        .map(|v| v.trim().to_owned())
        .find(|v| !v.is_empty())
}

fn builder() -> ureq::AgentBuilder {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(&format!("rd-agent/{}", rd_agent_core::AGENT_VERSION))
}

fn proxied(url: Option<String>) -> Option<ureq::Agent> {
    let url = url?;
    match ureq::Proxy::new(&url) {
        Ok(p) => Some(builder().proxy(p).build()),
        Err(e) => {
            log::warn!("ignoring invalid proxy setting: {e}");
            None
        }
    }
}

/// Splits `scheme://host[:port]/…` into `(scheme, host)`.
fn scheme_host(url: &str) -> Option<(&str, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next()?.to_owned()
    } else {
        authority.split(':').next()?.to_owned()
    };
    Some((scheme, host.to_ascii_lowercase()))
}

fn bypass(host: &str, no_proxy: &[String]) -> bool {
    if host == "localhost" || host == "::1" || host.starts_with("127.") {
        return true;
    }
    no_proxy.iter().any(|entry| {
        let e = entry.trim().trim_start_matches("*.").to_ascii_lowercase();
        if e.is_empty() {
            return false;
        }
        if e == "*" {
            return true;
        }
        let bare = e.trim_start_matches('.');
        host == bare || host.ends_with(&format!(".{bare}"))
    })
}

/// `HttpTransport` backed by `ureq` agents (direct, and per-scheme proxies).
pub struct UreqTransport {
    direct: ureq::Agent,
    https_proxy: Option<ureq::Agent>,
    http_proxy: Option<ureq::Agent>,
    no_proxy: Vec<String>,
}

impl UreqTransport {
    /// Creates a transport with conservative timeouts (10 s connect, 30 s overall).
    pub fn new() -> Self {
        let all = env_any(&["ALL_PROXY", "all_proxy"]);
        let no_proxy = env_any(&["NO_PROXY", "no_proxy"])
            .map(|s| s.split(',').map(str::to_owned).collect())
            .unwrap_or_default();
        Self {
            direct: builder().build(),
            https_proxy: proxied(env_any(&["HTTPS_PROXY", "https_proxy"]).or_else(|| all.clone())),
            http_proxy: proxied(env_any(&["HTTP_PROXY", "http_proxy"]).or(all)),
            no_proxy,
        }
    }

    fn agent_for(&self, url: &str) -> &ureq::Agent {
        let Some((scheme, host)) = scheme_host(url) else {
            return &self.direct;
        };
        if bypass(&host, &self.no_proxy) {
            return &self.direct;
        }
        let proxy = match scheme {
            "https" => self.https_proxy.as_ref(),
            "http" => self.http_proxy.as_ref(),
            _ => None,
        };
        proxy.unwrap_or(&self.direct)
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

fn read_body(resp: ureq::Response) -> Result<HttpResponse, TransportError> {
    let status = resp.status();
    let mut body = Vec::new();
    resp.into_reader()
        .take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut body)
        .map_err(|e| TransportError(format!("reading response: {e}")))?;
    Ok(HttpResponse { status, body })
}

impl HttpTransport for UreqTransport {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, TransportError> {
        let mut r = self
            .agent_for(&req.url)
            .request(req.method.as_str(), &req.url);
        for (k, v) in &req.headers {
            r = r.set(k, v);
        }
        let result = match (&req.method, req.body) {
            (Method::Get, _) | (_, None) => r.call(),
            (_, Some(body)) => r.send_bytes(&body),
        };
        match result {
            Ok(resp) => read_body(resp),
            Err(ureq::Error::Status(_, resp)) => read_body(resp),
            // Keep only the error kind: messages may contain presigned URLs.
            Err(ureq::Error::Transport(t)) => Err(TransportError(format!("{:?}", t.kind()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts() {
        assert_eq!(
            scheme_host("https://user:pw@Track.Example.com:8443/v1/x?y"),
            Some(("https", "track.example.com".into()))
        );
        assert_eq!(
            scheme_host("http://[::1]:3000/"),
            Some(("http", "::1".into()))
        );
        assert_eq!(scheme_host("nonsense"), None);
    }

    #[test]
    fn no_proxy_matching() {
        let np: Vec<String> = ["example.com", ".corp.test", "10.0.0.5"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(bypass("example.com", &np));
        assert!(bypass("api.example.com", &np));
        assert!(bypass("a.corp.test", &np));
        assert!(bypass("10.0.0.5", &np));
        assert!(bypass("127.0.0.1", &[]));
        assert!(bypass("localhost", &[]));
        assert!(!bypass("example.org", &np));
        assert!(!bypass("notexample.com", &np));
        assert!(bypass("anything", &["*".into()]));
    }
}
