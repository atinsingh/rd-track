//! Opening the agent's local state and enrolling a device — shared by the CLI and the
//! tray app so both behave identically.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rd_agent_core::api::{
    ApiClient, ApiError, EmailCodeRequest, EnrollRequest, LinkRequestCreate, LinkTokenRequest,
    LinkTokenResponse, Os,
};
use rd_agent_core::i18n::{fill, Lang};
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

/// On a computer IT deployed (G26): asks the organization's server to email the person a
/// one-time code. Employee-facing errors; the same success whether or not the email exists.
pub fn request_email_code(
    deployment: &config::Deployment,
    email: &str,
    lang: Lang,
) -> Result<(), String> {
    let m = lang.messages();
    let api = ApiClient::new(&deployment.server, Arc::new(http::UreqTransport::new()));
    api.request_email_code(&EmailCodeRequest {
        deployment_key: deployment.deployment_key.clone(),
        email: email.trim().to_owned(),
    })
    .map_err(|e| match e.code() {
        Some("invalid_deployment_key") => m.setup_key_invalid.to_owned(),
        Some("validation_failed") => m.setup_enter_email.to_owned(),
        _ if matches!(e, ApiError::Transport(_)) => {
            fill(m.setup_cant_reach, &[("server", &deployment.server)])
        }
        _ if matches!(e, ApiError::Http { status: 429, .. }) => m.setup_too_many.to_owned(),
        _ => fill(m.setup_code_failed, &[("error", &e.to_string())]),
    })
}

/// A sign-in in progress: the person confirms in the browser at `approve_url`, checking
/// `user_code` matches, while the app polls with `poll_secret`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkStart {
    /// The normalised server URL.
    pub server: String,
    /// The device name sent, reused when enrolling.
    pub device_name: String,
    /// The request to poll.
    pub request_id: String,
    /// Shown in the app and on the web page.
    pub user_code: String,
    /// Only this app knows it.
    pub poll_secret: String,
    /// Where the person signs in.
    pub approve_url: String,
    /// When the request lapses.
    pub expires_at: DateTime<Utc>,
    /// The server's polling interval.
    pub interval: Duration,
}

/// One poll's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInPoll {
    /// Not confirmed yet.
    Pending,
    /// Confirmed: the one-time enrollment code (collect it once).
    Approved(String),
    /// The person cancelled in the browser.
    Denied,
    /// Too late, already used, or unknown to the server.
    Expired,
}

/// A failed poll, with an employee-facing message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInError {
    /// Employee-facing message.
    pub message: String,
    /// Worth trying again after a pause (rate limit, network, server hiccup).
    pub retry: bool,
}

impl std::fmt::Display for SignInError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The shortest pause between polls, whatever the server says.
pub const MIN_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// The longest pause after repeated failures.
pub const MAX_POLL_BACKOFF: Duration = Duration::from_secs(60);

fn api_for(server: &str) -> ApiClient {
    ApiClient::new(server, Arc::new(http::UreqTransport::new()))
}

/// Starts signing in from the browser (`POST /v1/devices/link-requests`). The device
/// name defaults to this computer's name. Employee-facing errors.
pub fn start_sign_in(
    server: &str,
    device_name: Option<String>,
    os: Os,
    lang: Lang,
) -> Result<LinkStart, String> {
    start_sign_in_with(&api_for(server), device_name, os, lang)
}

/// [`start_sign_in`] against a given client.
pub fn start_sign_in_with(
    api: &ApiClient,
    device_name: Option<String>,
    os: Os,
    lang: Lang,
) -> Result<LinkStart, String> {
    let m = lang.messages();
    let device_name = device_name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(config::host_name);
    let created = api
        .create_link_request(&LinkRequestCreate {
            device_name: device_name.clone(),
            os,
        })
        .map_err(|e| match e {
            ApiError::Transport(_) => fill(m.setup_cant_reach, &[("server", api.base_url())]),
            ApiError::Http { status: 429, .. } => m.setup_too_many.to_owned(),
            // A server from before signing in existed.
            ApiError::Http {
                status: 404 | 405, ..
            } => fill(m.signin_unsupported, &[("server", api.base_url())]),
            e => fill(m.signin_failed, &[("error", &e.to_string())]),
        })?;
    Ok(LinkStart {
        server: api.base_url().to_owned(),
        device_name,
        request_id: created.request_id,
        user_code: created.user_code,
        poll_secret: created.poll_secret,
        approve_url: created.approve_url,
        expires_at: created.expires_at,
        interval: Duration::from_secs(created.interval_seconds).max(MIN_POLL_INTERVAL),
    })
}

/// Asks once whether the person has confirmed
/// (`POST /v1/devices/link-requests/{id}/token`).
pub fn poll_sign_in(start: &LinkStart, lang: Lang) -> Result<SignInPoll, SignInError> {
    poll_sign_in_with(&api_for(&start.server), start, lang)
}

/// [`poll_sign_in`] against a given client.
pub fn poll_sign_in_with(
    api: &ApiClient,
    start: &LinkStart,
    lang: Lang,
) -> Result<SignInPoll, SignInError> {
    let r = api.poll_link_token(
        &start.request_id,
        &LinkTokenRequest {
            poll_secret: start.poll_secret.clone(),
        },
    );
    classify_poll(r, &start.server, lang)
}

/// What one poll's response means (pure).
pub fn classify_poll(
    r: Result<LinkTokenResponse, ApiError>,
    server: &str,
    lang: Lang,
) -> Result<SignInPoll, SignInError> {
    let m = lang.messages();
    let fatal = |e: &dyn std::fmt::Display| SignInError {
        message: fill(m.signin_failed, &[("error", &e.to_string())]),
        retry: false,
    };
    match r {
        Ok(t) => match t.status.as_str() {
            "approved" => match t.enrollment_code.filter(|c| !c.trim().is_empty()) {
                Some(code) => Ok(SignInPoll::Approved(code)),
                None => Err(fatal(&"no connection code in the answer")),
            },
            "denied" => Ok(SignInPoll::Denied),
            "expired" | "used" => Ok(SignInPoll::Expired),
            _ => Ok(SignInPoll::Pending),
        },
        Err(e) => match (&e, e.code()) {
            (_, Some("link_denied")) => Ok(SignInPoll::Denied),
            (_, Some("link_expired")) => Ok(SignInPoll::Expired),
            (ApiError::Http { status: 404, .. }, _) | (ApiError::Http { status: 410, .. }, _) => {
                Ok(SignInPoll::Expired)
            }
            (ApiError::Transport(_), _) => Err(SignInError {
                message: fill(m.setup_cant_reach, &[("server", server)]),
                retry: true,
            }),
            (ApiError::Http { status: 429, .. }, _) => Err(SignInError {
                message: m.setup_too_many.to_owned(),
                retry: true,
            }),
            _ if e.is_retryable() => Err(SignInError {
                message: fill(m.signin_failed, &[("error", &e.to_string())]),
                retry: true,
            }),
            _ => Err(fatal(&e)),
        },
    }
}

/// The pause before the next poll: the server's interval (at least
/// [`MIN_POLL_INTERVAL`]) after an answer, doubling per consecutive failure up to
/// [`MAX_POLL_BACKOFF`].
pub fn poll_delay(interval: Duration, failures: u32) -> Duration {
    let base = interval.max(MIN_POLL_INTERVAL);
    let factor = 1u32 << failures.min(6);
    (base * factor).min(MAX_POLL_BACKOFF.max(base))
}

/// How a sign-in ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInEnd {
    /// Confirmed: the one-time enrollment code.
    Approved(String),
    /// Cancelled in the browser.
    Denied,
    /// Ran out of time.
    Expired,
    /// A failure that trying again won't fix (employee-facing).
    Failed(String),
    /// Stopped from this app.
    Cancelled,
}

/// Polls until the sign-in ends: pending answers wait the interval, rate limits and
/// network failures back off, and nothing is asked after `expires_at`. `sleep` returns
/// `false` when the wait was cancelled.
pub fn wait_for_sign_in(
    start: &LinkStart,
    mut poll: impl FnMut() -> Result<SignInPoll, SignInError>,
    mut sleep: impl FnMut(Duration) -> bool,
    now: impl Fn() -> DateTime<Utc>,
) -> SignInEnd {
    let mut failures = 0u32;
    loop {
        if !sleep(poll_delay(start.interval, failures)) {
            return SignInEnd::Cancelled;
        }
        if now() >= start.expires_at {
            return SignInEnd::Expired;
        }
        match poll() {
            Ok(SignInPoll::Pending) => failures = 0,
            Ok(SignInPoll::Approved(code)) => return SignInEnd::Approved(code),
            Ok(SignInPoll::Denied) => return SignInEnd::Denied,
            Ok(SignInPoll::Expired) => return SignInEnd::Expired,
            Err(e) if e.retry => {
                log::info!("sign-in poll failed, backing off: {}", e.message);
                failures = failures.saturating_add(1);
            }
            Err(e) => return SignInEnd::Failed(e.message),
        }
    }
}

/// The employee-facing message for a sign-in that ended without connecting.
pub fn sign_in_end_message(end: &SignInEnd, lang: Lang) -> Option<String> {
    let m = lang.messages();
    match end {
        SignInEnd::Approved(_) | SignInEnd::Cancelled => None,
        SignInEnd::Denied => Some(m.signin_denied.to_owned()),
        SignInEnd::Expired => Some(m.signin_expired.to_owned()),
        SignInEnd::Failed(msg) => Some(msg.clone()),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rd_agent_core::platform::{HttpRequest, HttpResponse, HttpTransport, TransportError};
    use std::collections::VecDeque;

    #[derive(Default)]
    struct Canned(
        Mutex<VecDeque<Result<HttpResponse, TransportError>>>,
        Mutex<Vec<HttpRequest>>,
    );

    impl Canned {
        fn with(items: Vec<Result<(u16, serde_json::Value), &str>>) -> Arc<Self> {
            let c = Self::default();
            for i in items {
                c.0.lock().unwrap().push_back(match i {
                    Ok((status, body)) => Ok(HttpResponse {
                        status,
                        body: serde_json::to_vec(&body).unwrap(),
                    }),
                    Err(e) => Err(TransportError(e.into())),
                });
            }
            Arc::new(c)
        }
    }

    impl HttpTransport for Canned {
        fn send(&self, req: HttpRequest) -> Result<HttpResponse, TransportError> {
            self.1.lock().unwrap().push(req);
            self.0
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected request")
        }
    }

    fn start() -> LinkStart {
        LinkStart {
            server: "https://x.test".into(),
            device_name: "laptop".into(),
            request_id: "r1".into(),
            user_code: "ABCD-2345".into(),
            poll_secret: "secret-secret-secret".into(),
            approve_url: "https://x.test/connect/r1".into(),
            expires_at: Utc.with_ymd_and_hms(2026, 10, 31, 10, 10, 0).unwrap(),
            interval: Duration::from_secs(5),
        }
    }

    #[test]
    fn starting_sends_the_name_and_keeps_the_answer() {
        let t = Canned::with(vec![Ok((
            201,
            serde_json::json!({"request_id": "r1", "user_code": "ABCD-2345",
                "poll_secret": "secret-secret-secret", "approve_url": "https://x.test/connect/r1",
                "expires_at": "2026-10-31T10:10:00Z", "interval_seconds": 1}),
        ))]);
        let api = ApiClient::new("https://x.test/", t.clone());
        let s = start_sign_in_with(&api, Some("  laptop ".into()), Os::Macos, Lang::En).unwrap();
        assert_eq!(
            s,
            LinkStart {
                interval: MIN_POLL_INTERVAL,
                ..start()
            }
        );
        let body: serde_json::Value =
            serde_json::from_slice(t.1.lock().unwrap()[0].body.as_ref().unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"device_name": "laptop", "os": "macos"})
        );
    }

    #[test]
    fn starting_explains_failures() {
        let t = Canned::with(vec![
            Err("dns"),
            Ok((404, serde_json::json!({"error": {"code": "not_found"}}))),
            Ok((429, serde_json::json!({}))),
        ]);
        let api = ApiClient::new("https://x.test", t);
        let e = start_sign_in_with(&api, None, Os::Linux, Lang::En).unwrap_err();
        assert!(e.starts_with("Can't reach https://x.test"), "{e}");
        let e = start_sign_in_with(&api, None, Os::Linux, Lang::Fr).unwrap_err();
        assert!(e.contains("ne permet pas encore"), "{e}");
        let e = start_sign_in_with(&api, None, Os::Linux, Lang::En).unwrap_err();
        assert!(e.starts_with("Too many tries"), "{e}");
    }

    #[test]
    fn polls_are_classified() {
        let s = "https://x.test";
        let ok = |v: serde_json::Value| Ok(serde_json::from_value::<LinkTokenResponse>(v).unwrap());
        let http = |status, code: &str| {
            Err(ApiError::Http {
                status,
                code: Some(code.into()),
            })
        };
        let en = Lang::En;
        assert_eq!(
            classify_poll(ok(serde_json::json!({"status": "pending"})), s, en),
            Ok(SignInPoll::Pending)
        );
        assert_eq!(
            classify_poll(
                ok(serde_json::json!({"status": "approved", "enrollment_code": "C0DE"})),
                s,
                en
            ),
            Ok(SignInPoll::Approved("C0DE".into()))
        );
        assert!(
            !classify_poll(ok(serde_json::json!({"status": "approved"})), s, en)
                .unwrap_err()
                .retry
        );
        assert_eq!(
            classify_poll(http(410, "link_denied"), s, en),
            Ok(SignInPoll::Denied)
        );
        assert_eq!(
            classify_poll(http(410, "link_expired"), s, en),
            Ok(SignInPoll::Expired)
        );
        assert_eq!(
            classify_poll(http(404, "not_found"), s, en),
            Ok(SignInPoll::Expired)
        );
        assert!(
            classify_poll(http(429, "rate_limited"), s, en)
                .unwrap_err()
                .retry
        );
        assert!(classify_poll(http(503, "x"), s, en).unwrap_err().retry);
        assert!(
            classify_poll(Err(ApiError::Transport("down".into())), s, en)
                .unwrap_err()
                .retry
        );
        let e = classify_poll(http(400, "validation_failed"), s, Lang::Fr).unwrap_err();
        assert!(!e.retry);
        assert!(
            e.message.starts_with("Impossible de se connecter :"),
            "{}",
            e.message
        );
    }

    #[test]
    fn polling_requests_carry_the_secret() {
        let t = Canned::with(vec![Ok((200, serde_json::json!({"status": "pending"})))]);
        let api = ApiClient::new("https://x.test", t.clone());
        assert_eq!(
            poll_sign_in_with(&api, &start(), Lang::En),
            Ok(SignInPoll::Pending)
        );
        let req = &t.1.lock().unwrap()[0];
        assert_eq!(req.url, "https://x.test/v1/devices/link-requests/r1/token");
        let body: serde_json::Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"poll_secret": "secret-secret-secret"})
        );
    }

    #[test]
    fn delays_respect_the_floor_and_back_off() {
        let s = Duration::from_secs;
        assert_eq!(poll_delay(s(0), 0), s(2));
        assert_eq!(poll_delay(s(5), 0), s(5));
        assert_eq!(poll_delay(s(5), 1), s(10));
        assert_eq!(poll_delay(s(5), 3), s(40));
        assert_eq!(poll_delay(s(5), 30), s(60));
        assert_eq!(poll_delay(s(90), 2), s(90));
    }

    /// Runs the loop over scripted answers on a fake clock that sleeping advances.
    fn run(
        answers: Vec<Result<SignInPoll, SignInError>>,
        cancel_after: Option<usize>,
    ) -> (SignInEnd, Vec<Duration>, usize) {
        let st = start();
        let clock = std::cell::Cell::new(st.expires_at - chrono::Duration::minutes(10));
        let mut answers: VecDeque<_> = answers.into();
        let mut polls = 0;
        let mut sleeps = Vec::new();
        let end = wait_for_sign_in(
            &st,
            || {
                polls += 1;
                answers.pop_front().unwrap_or(Ok(SignInPoll::Pending))
            },
            |d| {
                sleeps.push(d);
                clock.set(clock.get() + chrono::Duration::from_std(d).unwrap());
                cancel_after.is_none_or(|n| sleeps.len() <= n)
            },
            || clock.get(),
        );
        (end, sleeps, polls)
    }

    #[test]
    fn the_loop_waits_backs_off_and_ends() {
        let s = Duration::from_secs;
        let busy = || {
            Err(SignInError {
                message: "busy".into(),
                retry: true,
            })
        };
        let (end, sleeps, _) = run(
            vec![
                Ok(SignInPoll::Pending),
                busy(),
                busy(),
                Ok(SignInPoll::Pending),
                Ok(SignInPoll::Approved("C".into())),
            ],
            None,
        );
        assert_eq!(end, SignInEnd::Approved("C".into()));
        assert_eq!(sleeps, [s(5), s(5), s(10), s(20), s(5)]);

        assert_eq!(run(vec![Ok(SignInPoll::Denied)], None).0, SignInEnd::Denied);
        let fatal = Err(SignInError {
            message: "nope".into(),
            retry: false,
        });
        assert_eq!(run(vec![fatal], None).0, SignInEnd::Failed("nope".into()));

        // Pending forever: gives up at expires_at (10 minutes at 5 s = 119 polls).
        let (end, _, polls) = run(vec![], None);
        assert_eq!(end, SignInEnd::Expired);
        assert_eq!(polls, 119);

        // Cancelled from the app: no further poll.
        let (end, _, polls) = run(vec![], Some(2));
        assert_eq!(end, SignInEnd::Cancelled);
        assert_eq!(polls, 2);
    }

    #[test]
    fn endings_have_messages() {
        assert_eq!(sign_in_end_message(&SignInEnd::Cancelled, Lang::En), None);
        assert_eq!(
            sign_in_end_message(&SignInEnd::Approved("c".into()), Lang::En),
            None
        );
        assert_eq!(
            sign_in_end_message(&SignInEnd::Denied, Lang::Fr).as_deref(),
            Some("La connexion a été annulée dans le navigateur.")
        );
        assert!(sign_in_end_message(&SignInEnd::Expired, Lang::En)
            .unwrap()
            .contains("too long"));
    }
}
