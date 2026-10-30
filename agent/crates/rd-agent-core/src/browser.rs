//! Website domains (Pro): the approved browser integration.
//!
//! The Track browser extension (`agent/browser-extension/`) tells a native messaging host
//! (the desktop app, started by the browser) the hostname of the active tab. The host and
//! the agent never talk directly; they share a few small files in `<data-dir>/browser/`:
//!
//! | file | written by | holds |
//! |---|---|---|
//! | `wanted` | the agent, while a session is `Active` and the policy collects domains | when that stops being true unless renewed |
//! | `<family>.json` | the host, on every message from the extension | `{domain, at, instance}` |
//!
//! Without a current `wanted` file the host stores no domain (only that the extension is
//! there) and tells the extension to stop sending them. The agent attaches a domain to an
//! app segment only when the app in the foreground is a browser of that family and the
//! host heard from it in the last [`FRESH_SECONDS`].
//!
//! Only a hostname ever crosses: no path, no query, nothing from private windows.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use crate::platform::{ForegroundApp, ForegroundAppInfo, PermissionStatus};

/// The native messaging host's name (the same in every browser).
pub const HOST_NAME: &str = "digital.round.track";
/// The Firefox extension's ID.
pub const FIREFOX_EXTENSION_ID: &str = "browser@track.round.digital";
/// A report older than this is not used (the extension renews it every 30 s).
pub const FRESH_SECONDS: i64 = 90;
/// An extension heard from in this window counts as connected (heartbeat, status).
pub const SEEN_SECONDS: i64 = 300;
/// The agent's `wanted` mark lasts this long unless renewed (a crashed agent stops it).
pub const WANTED_SECONDS: i64 = 120;
/// Largest message accepted from the extension (they are tiny).
pub const MAX_MESSAGE_BYTES: u32 = 4096;

/// Which kind of browser an extension instance runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserFamily {
    /// Chrome, Edge, Brave, Chromium.
    Chromium,
    /// Firefox.
    Firefox,
}

impl BrowserFamily {
    /// Every family.
    pub const ALL: [BrowserFamily; 2] = [BrowserFamily::Chromium, BrowserFamily::Firefox];

    /// Stable name (file name, heartbeat field).
    pub fn name(self) -> &'static str {
        match self {
            BrowserFamily::Chromium => "chromium",
            BrowserFamily::Firefox => "firefox",
        }
    }

    /// The family of a foreground app (macOS bundle id or Windows executable), if it is a
    /// browser the extension supports.
    pub fn of_app(app_identifier: &str) -> Option<Self> {
        let id = app_identifier.to_ascii_lowercase();
        const CHROMIUM: &[&str] = &[
            "com.google.chrome",
            "com.microsoft.edgemac",
            "com.brave.browser",
            "org.chromium.chromium",
        ];
        const FIREFOX: &[&str] = &[
            "org.mozilla.firefox",
            "org.mozilla.firefoxdeveloperedition",
            "org.mozilla.nightly",
        ];
        // Bundle ids, with their beta/dev/canary channels (`com.google.Chrome.beta`).
        let bundle = |list: &[&str]| {
            list.iter()
                .any(|b| id == *b || id.strip_prefix(b).is_some_and(|r| r.starts_with('.')))
        };
        if bundle(CHROMIUM)
            || matches!(
                id.as_str(),
                "chrome.exe" | "msedge.exe" | "brave.exe" | "chromium.exe"
            )
        {
            Some(BrowserFamily::Chromium)
        } else if bundle(FIREFOX) || id == "firefox.exe" {
            Some(BrowserFamily::Firefox)
        } else {
            None
        }
    }

    /// The family a native messaging host was started for, from its arguments: Chromium
    /// browsers pass the caller's origin (`chrome-extension://<id>/`), Firefox the path of
    /// the host manifest and the extension's ID.
    pub fn of_host_args<S: AsRef<str>>(args: &[S]) -> Option<Self> {
        if args
            .iter()
            .any(|a| a.as_ref().starts_with("chrome-extension://"))
        {
            Some(BrowserFamily::Chromium)
        } else if args.iter().any(|a| a.as_ref() == FIREFOX_EXTENSION_ID) {
            Some(BrowserFamily::Firefox)
        } else {
            None
        }
    }
}

/// A hostname as it is recorded: lowercase, without `www.`, only `[a-z0-9.-]`, at most
/// 253 characters. Anything else (a path, a port, a scheme, an empty name) is refused.
pub fn normalize_domain(host: &str) -> Option<String> {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let h = h.strip_prefix("www.").unwrap_or(&h);
    let ok = !h.is_empty()
        && h.len() <= 253
        && h.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !h.starts_with('.')
        && !h.contains("..");
    ok.then(|| h.to_owned())
}

/// What the host keeps for one family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// The active tab's domain, when the agent wanted one.
    pub domain: Option<String>,
    /// When the host last heard from the extension.
    #[serde(with = "crate::ts")]
    pub at: DateTime<Utc>,
    /// Which extension instance (a browser profile) said it.
    pub instance: String,
}

/// The shared directory.
#[derive(Debug, Clone)]
pub struct Bridge {
    dir: PathBuf,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

impl Bridge {
    /// The bridge under `<data_dir>/browser`.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("browser"),
        }
    }

    fn wanted_path(&self) -> PathBuf {
        self.dir.join("wanted")
    }

    fn report_path(&self, family: BrowserFamily) -> PathBuf {
        self.dir.join(format!("{}.json", family.name()))
    }

    /// Agent: domains are wanted until `until`, or (`None`) not at all. Turning them off
    /// also deletes every stored domain.
    pub fn set_wanted(&self, until: Option<DateTime<Utc>>) -> io::Result<()> {
        match until {
            Some(t) => {
                fs::create_dir_all(&self.dir)?;
                write_atomic(&self.wanted_path(), crate::ts::format(&t).as_bytes())
            }
            None => {
                remove(&self.wanted_path())?;
                for f in BrowserFamily::ALL {
                    // Keep the liveness, drop the domain.
                    if let Some(mut r) = self.report(f) {
                        if r.domain.take().is_some() {
                            write_atomic(&self.report_path(f), &serde_json::to_vec(&r)?)?;
                        }
                    }
                }
                Ok(())
            }
        }
    }

    /// Whether the agent wants domains at `now`.
    pub fn wanted(&self, now: DateTime<Utc>) -> bool {
        fs::read_to_string(self.wanted_path())
            .ok()
            .and_then(|s| crate::ts::parse(s.trim()))
            .is_some_and(|until| now < until)
    }

    /// The host's last report for `family`.
    pub fn report(&self, family: BrowserFamily) -> Option<Report> {
        let bytes = fs::read(self.report_path(family)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Host: records what `instance` said at `now`. A domain is kept only while wanted. An
    /// instance that lost focus (`None`) clears only a domain it reported itself, so a blur
    /// in one browser profile never hides the focus another just reported.
    pub fn record(
        &self,
        family: BrowserFamily,
        instance: &str,
        domain: Option<&str>,
        now: DateTime<Utc>,
    ) -> io::Result<bool> {
        let wanted = self.wanted(now);
        let domain = domain.filter(|_| wanted).and_then(normalize_domain);
        if domain.is_none() {
            if let Some(p) = self.report(family) {
                if p.instance != instance
                    && p.domain.is_some()
                    && now - p.at <= TimeDelta::seconds(FRESH_SECONDS)
                {
                    return Ok(wanted);
                }
            }
        }
        let r = Report {
            domain,
            at: crate::ts::to_millis(now),
            instance: instance.to_owned(),
        };
        fs::create_dir_all(&self.dir)?;
        write_atomic(&self.report_path(family), &serde_json::to_vec(&r)?)?;
        Ok(wanted)
    }

    /// Agent: the active tab's domain for `family`, if the host reported one recently.
    pub fn domain(&self, family: BrowserFamily, now: DateTime<Utc>) -> Option<String> {
        let r = self.report(family)?;
        let age = now - r.at;
        (age >= -TimeDelta::seconds(5) && age <= TimeDelta::seconds(FRESH_SECONDS))
            .then_some(r.domain)
            .flatten()
            .and_then(|d| normalize_domain(&d))
    }

    /// Families whose extension the host heard from in the last [`SEEN_SECONDS`].
    pub fn seen(&self, now: DateTime<Utc>) -> Vec<BrowserFamily> {
        BrowserFamily::ALL
            .into_iter()
            .filter(|f| {
                self.report(*f)
                    .is_some_and(|r| (now - r.at).num_seconds().abs() <= SEEN_SECONDS)
            })
            .collect()
    }
}

fn remove(p: &Path) -> io::Result<()> {
    match fs::remove_file(p) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

// ----- native messaging host ----------------------------------------------------------

/// Reads one native message (32-bit length in native byte order, then UTF-8 JSON).
/// `Ok(None)` at end of input: the browser closed the port.
pub fn read_message(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
        Ok(()) => {}
    }
    let n = u32::from_ne_bytes(len);
    if n > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut buf = vec![0u8; n as usize];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Writes one native message.
pub fn write_message(w: &mut impl Write, body: &[u8]) -> io::Result<()> {
    let n = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "message too large"))?;
    w.write_all(&n.to_ne_bytes())?;
    w.write_all(body)?;
    w.flush()
}

#[derive(Debug, Deserialize)]
struct FromExtension {
    instance: String,
    #[serde(default)]
    domain: Option<String>,
}

/// What the host answers: whether the extension should send domains.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HostReply {
    /// `true` while a session is collecting domains.
    pub collect: bool,
}

/// Handles one message from the extension.
pub fn handle_message(
    bridge: &Bridge,
    family: BrowserFamily,
    body: &[u8],
    now: DateTime<Utc>,
) -> io::Result<HostReply> {
    let msg: FromExtension =
        serde_json::from_slice(body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let instance: String = msg
        .instance
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(64)
        .collect();
    if instance.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "no instance"));
    }
    let collect = bridge.record(family, &instance, msg.domain.as_deref(), now)?;
    Ok(HostReply { collect })
}

/// Runs the host until the browser closes the port.
pub fn run_host(
    bridge: &Bridge,
    family: BrowserFamily,
    input: &mut impl Read,
    output: &mut impl Write,
    now: impl Fn() -> DateTime<Utc>,
) -> io::Result<()> {
    while let Some(body) = read_message(input)? {
        let reply = match handle_message(bridge, family, &body, now()) {
            Ok(r) => r,
            // A malformed message is ignored, not fatal.
            Err(e) if e.kind() == io::ErrorKind::InvalidData => continue,
            Err(e) => return Err(e),
        };
        write_message(output, &serde_json::to_vec(&reply)?)?;
    }
    Ok(())
}

// ----- the agent's side ---------------------------------------------------------------

/// Wraps a foreground source with the browser bridge: knows the active tab's domain when
/// the foreground app is a supported browser and the policy wants domains.
pub struct BrowserAware<F> {
    inner: F,
    bridge: Bridge,
    wanted_until: Option<DateTime<Utc>>,
    seen: Option<(DateTime<Utc>, Vec<BrowserFamily>)>,
}

impl<F: ForegroundApp> BrowserAware<F> {
    /// Wraps `inner`, sharing `<data_dir>/browser` with the host.
    pub fn new(inner: F, data_dir: &Path) -> Self {
        let me = Self {
            inner,
            bridge: Bridge::new(data_dir),
            wanted_until: None,
            seen: None,
        };
        // Whatever an earlier run left behind is not wanted now.
        if let Err(e) = me.bridge.set_wanted(None) {
            log::debug!("browser bridge: {e}");
        }
        me
    }
}

impl<F: ForegroundApp> ForegroundApp for BrowserAware<F> {
    fn current(&mut self) -> Option<ForegroundAppInfo> {
        self.inner.current()
    }

    fn permission(&self) -> PermissionStatus {
        self.inner.permission()
    }

    fn want_domains(&mut self, now: Option<DateTime<Utc>>) {
        let result = match (now, self.wanted_until) {
            // Renew when less than half the mark is left.
            (Some(now), until)
                if until.is_none_or(|u| u - now < TimeDelta::seconds(WANTED_SECONDS / 2)) =>
            {
                let until = now + TimeDelta::seconds(WANTED_SECONDS);
                self.wanted_until = Some(until);
                self.bridge.set_wanted(Some(until))
            }
            (None, Some(_)) => {
                self.wanted_until = None;
                self.bridge.set_wanted(None)
            }
            _ => Ok(()),
        };
        if let Err(e) = result {
            log::debug!("browser bridge: {e}");
        }
    }

    fn active_domain(&mut self, app: &ForegroundAppInfo, now: DateTime<Utc>) -> Option<String> {
        self.wanted_until?;
        let family = BrowserFamily::of_app(&app.app_identifier)?;
        self.bridge.domain(family, now)
    }

    fn browser_extensions(&mut self, now: DateTime<Utc>) -> Vec<BrowserFamily> {
        match &self.seen {
            Some((at, seen)) if (now - *at).num_seconds().abs() < 15 => seen.clone(),
            _ => {
                let seen = self.bridge.seen(now);
                self.seen = Some((now, seen.clone()));
                seen
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(s: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 30, 9, 0, 0).unwrap() + TimeDelta::seconds(s)
    }

    struct Fixed(&'static str);
    impl ForegroundApp for Fixed {
        fn current(&mut self) -> Option<ForegroundAppInfo> {
            Some(app(self.0))
        }
    }
    fn app(id: &str) -> ForegroundAppInfo {
        ForegroundAppInfo {
            app_identifier: id.into(),
            app_name: id.into(),
        }
    }

    #[test]
    fn knows_the_supported_browsers() {
        assert_eq!(
            BrowserFamily::of_app("com.google.Chrome"),
            Some(BrowserFamily::Chromium)
        );
        assert_eq!(
            BrowserFamily::of_app("com.google.Chrome.beta"),
            Some(BrowserFamily::Chromium)
        );
        assert_eq!(
            BrowserFamily::of_app("msedge.exe"),
            Some(BrowserFamily::Chromium)
        );
        assert_eq!(
            BrowserFamily::of_app("org.mozilla.firefox"),
            Some(BrowserFamily::Firefox)
        );
        assert_eq!(
            BrowserFamily::of_app("Firefox.exe"),
            Some(BrowserFamily::Firefox)
        );
        assert_eq!(BrowserFamily::of_app("com.google.Chromecast"), None);
        assert_eq!(BrowserFamily::of_app("com.apple.Safari"), None);
        assert_eq!(
            BrowserFamily::of_host_args(&["chrome-extension://abc/"]),
            Some(BrowserFamily::Chromium)
        );
        assert_eq!(
            BrowserFamily::of_host_args(&["/x/digital.round.track.json", FIREFOX_EXTENSION_ID]),
            Some(BrowserFamily::Firefox)
        );
        assert_eq!(
            BrowserFamily::of_host_args(&["rdtrack://enroll?code=1"]),
            None
        );
    }

    #[test]
    fn keeps_the_hostname_only() {
        assert_eq!(
            normalize_domain("WWW.GitHub.com."),
            Some("github.com".into())
        );
        assert_eq!(normalize_domain("docs.rs"), Some("docs.rs".into()));
        assert_eq!(
            normalize_domain("192.168.1.10"),
            Some("192.168.1.10".into())
        );
        for bad in [
            "",
            "  ",
            "github.com/x",
            "a b",
            "user@host",
            "host:8080",
            "..x",
            "ex\u{e4}mple.com",
            &"a".repeat(254),
        ] {
            assert_eq!(normalize_domain(bad), None, "{bad}");
        }
    }

    #[test]
    fn frames_messages() {
        let mut buf = Vec::new();
        write_message(&mut buf, br#"{"collect":true}"#).unwrap();
        assert_eq!(&buf[..4], &16u32.to_ne_bytes());
        let mut r = &buf[..];
        assert_eq!(
            read_message(&mut r).unwrap().unwrap(),
            br#"{"collect":true}"#
        );
        assert_eq!(read_message(&mut r).unwrap(), None);
        let huge = (MAX_MESSAGE_BYTES + 1).to_ne_bytes();
        assert!(read_message(&mut &huge[..]).is_err());
    }

    fn msg(instance: &str, domain: Option<&str>) -> Vec<u8> {
        let mut out = Vec::new();
        let body = serde_json::json!({ "instance": instance, "domain": domain }).to_string();
        write_message(&mut out, body.as_bytes()).unwrap();
        out
    }

    fn host(b: &Bridge, family: BrowserFamily, msgs: &[Vec<u8>], at: DateTime<Utc>) -> Vec<bool> {
        let input = msgs.concat();
        let mut out = Vec::new();
        run_host(b, family, &mut &input[..], &mut out, || at).unwrap();
        let mut r = &out[..];
        let mut replies = Vec::new();
        while let Some(m) = read_message(&mut r).unwrap() {
            replies.push(
                serde_json::from_slice::<serde_json::Value>(&m).unwrap()["collect"]
                    .as_bool()
                    .unwrap(),
            );
        }
        replies
    }

    #[test]
    fn the_host_keeps_no_domain_unless_the_agent_wants_one() {
        let dir = tempfile::tempdir().unwrap();
        let b = Bridge::new(dir.path());
        assert_eq!(
            host(
                &b,
                BrowserFamily::Chromium,
                &[msg("a1", Some("github.com"))],
                t(0)
            ),
            [false]
        );
        let r = b.report(BrowserFamily::Chromium).unwrap();
        assert_eq!((r.domain, r.at), (None, t(0)));
        assert_eq!(b.seen(t(10)), [BrowserFamily::Chromium]);

        b.set_wanted(Some(t(120))).unwrap();
        // A malformed message is skipped; the next one still counts.
        let replies = host(
            &b,
            BrowserFamily::Chromium,
            &[b"\x02\0\0\0{}".to_vec(), msg("a1", Some("www.GitHub.com"))],
            t(1),
        );
        assert_eq!(replies, [true]);
        assert_eq!(
            b.domain(BrowserFamily::Chromium, t(30)),
            Some("github.com".into())
        );
        assert_eq!(
            b.domain(BrowserFamily::Chromium, t(1 + FRESH_SECONDS + 1)),
            None,
            "stale"
        );
        assert_eq!(b.domain(BrowserFamily::Firefox, t(30)), None);

        // The mark expires: nothing is kept after that.
        assert_eq!(
            host(
                &b,
                BrowserFamily::Chromium,
                &[msg("a1", Some("example.com"))],
                t(121)
            ),
            [false]
        );
        assert_eq!(b.report(BrowserFamily::Chromium).unwrap().domain, None);

        // Turning domains off wipes them.
        b.set_wanted(Some(t(300))).unwrap();
        host(
            &b,
            BrowserFamily::Chromium,
            &[msg("a1", Some("example.com"))],
            t(200),
        );
        b.set_wanted(None).unwrap();
        assert!(!b.wanted(t(201)));
        assert_eq!(b.report(BrowserFamily::Chromium).unwrap().domain, None);
    }

    #[test]
    fn a_blur_in_one_profile_does_not_hide_another() {
        let dir = tempfile::tempdir().unwrap();
        let b = Bridge::new(dir.path());
        b.set_wanted(Some(t(600))).unwrap();
        host(
            &b,
            BrowserFamily::Chromium,
            &[msg("work", Some("github.com"))],
            t(0),
        );
        host(
            &b,
            BrowserFamily::Chromium,
            &[msg("home", Some("news.example"))],
            t(1),
        );
        // The first profile's window lost focus after the second gained it.
        host(&b, BrowserFamily::Chromium, &[msg("work", None)], t(2));
        assert_eq!(
            b.domain(BrowserFamily::Chromium, t(3)),
            Some("news.example".into())
        );
        // The focused profile's own blur clears it.
        host(&b, BrowserFamily::Chromium, &[msg("home", None)], t(4));
        assert_eq!(b.domain(BrowserFamily::Chromium, t(5)), None);
    }

    #[test]
    fn the_agent_side_asks_only_while_wanted_and_only_for_browsers() {
        let dir = tempfile::tempdir().unwrap();
        let b = Bridge::new(dir.path());
        b.set_wanted(Some(t(600))).unwrap();
        host(
            &b,
            BrowserFamily::Chromium,
            &[msg("a", Some("github.com"))],
            t(0),
        );
        // A new run starts from "not wanted".
        let mut fg = BrowserAware::new(Fixed("com.google.Chrome"), dir.path());
        assert!(!b.wanted(t(1)));
        assert_eq!(fg.active_domain(&app("com.google.Chrome"), t(1)), None);

        fg.want_domains(Some(t(1)));
        assert!(b.wanted(t(1)));
        host(
            &b,
            BrowserFamily::Chromium,
            &[msg("a", Some("github.com"))],
            t(2),
        );
        assert_eq!(
            fg.active_domain(&app("com.google.Chrome"), t(3)),
            Some("github.com".into())
        );
        assert_eq!(fg.active_domain(&app("com.apple.Terminal"), t(3)), None);
        assert_eq!(fg.browser_extensions(t(3)), [BrowserFamily::Chromium]);

        // Renewed before it runs out.
        fg.want_domains(Some(t(100)));
        assert!(b.wanted(t(200)));

        fg.want_domains(None);
        assert!(!b.wanted(t(101)));
        assert_eq!(fg.active_domain(&app("com.google.Chrome"), t(101)), None);
        assert_eq!(b.report(BrowserFamily::Chromium).unwrap().domain, None);
    }
}
