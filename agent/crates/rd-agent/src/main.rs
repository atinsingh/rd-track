//! `rd-agent`: the RoundDigital Track desktop agent (headless) and developer CLI.
//!
//! ```text
//! rd-agent enroll --server https://track.example.com --code ABCDEFGHJK
//! rd-agent run --project <id> --simulate
//! rd-agent status
//! ```

mod config;
mod credentials;
mod http;
mod simulated;

use std::io::BufRead;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clap::{Parser, Subcommand};
use rd_agent_core::api::{ApiClient, EnrollRequest, Os};
use rd_agent_core::clock::SystemClock;
use rd_agent_core::events::StopReason;
use rd_agent_core::identity::DeviceIdentity;
use rd_agent_core::outbox::{CredentialStoreKey, Outbox, OutboxConfig, SharedOutbox};
use rd_agent_core::platform::{secret_names, CredentialStore};
use rd_agent_core::policy::decode_b64;
use rd_agent_core::runtime::{
    stored_status, AgentConfig, AgentHandle, Command, RunOptions, Runtime, RuntimeDeps,
};

use crate::config::Paths;

/// RoundDigital Track desktop agent.
#[derive(Debug, Parser)]
#[command(name = "rd-agent", version, about)]
struct Cli {
    /// Data directory (default: $RD_AGENT_DATA_DIR or the platform data directory).
    #[arg(long, global = true, value_name = "DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Enroll this device with a one-time code from your administrator.
    Enroll {
        /// Server base URL, e.g. https://track.example.com
        #[arg(long)]
        server: String,
        /// One-time enrollment code.
        #[arg(long)]
        code: String,
        /// Device name shown to administrators (default: host name).
        #[arg(long)]
        device_name: Option<String>,
        /// Re-enroll even if this device is already enrolled (wipes local data).
        #[arg(long)]
        force: bool,
    },
    /// Start a work session and track until interrupted (Ctrl-C stops the session).
    Run {
        /// Project to book the session to.
        #[arg(long)]
        project: Option<String>,
        /// Task to book the session to.
        #[arg(long)]
        task: Option<String>,
        /// Use the simulated platform (required on Linux; native collectors are not
        /// part of this build).
        #[arg(long)]
        simulate: bool,
        /// Seed for the simulated platform and screenshot slots.
        #[arg(long)]
        seed: Option<u64>,
        /// Stop the session and exit after this many seconds.
        #[arg(long, value_name = "SECS")]
        duration: Option<u64>,
        /// Do not start a session automatically (use --stdin-control to start one).
        #[arg(long)]
        no_auto_start: bool,
        /// Read commands from stdin: `start [project]`, `pause`, `resume`, `stop`, `quit`.
        #[arg(long)]
        stdin_control: bool,
    },
    /// Show enrollment, session and outbox status.
    Status {
        /// Print JSON.
        #[arg(long)]
        json: bool,
    },
}

/// The credential store: the OS keychain when built with `--features keychain` (unless
/// `RD_AGENT_CREDENTIAL_STORE=file`), otherwise `0600` files under the data directory.
fn credential_store(paths: &Paths) -> Arc<dyn CredentialStore> {
    #[cfg(feature = "keychain")]
    if std::env::var("RD_AGENT_CREDENTIAL_STORE").as_deref() != Ok("file") {
        return Arc::new(credentials::KeychainCredentialStore::new(format!(
            "rd-agent:{}",
            paths.root.display()
        )));
    }
    Arc::new(credentials::FileCredentialStore::new(paths.secrets()))
}

fn open_outbox(paths: &Paths, creds: &dyn CredentialStore) -> Result<SharedOutbox, String> {
    let outbox = Outbox::open(
        &paths.outbox(),
        &CredentialStoreKey(creds),
        OutboxConfig::default(),
    )
    .map_err(|e| format!("cannot open outbox: {e}"))?;
    Ok(Arc::new(Mutex::new(outbox)))
}

fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_target(false)
        .init();
    let cli = Cli::parse();
    let paths = Paths::new(config::data_dir(cli.data_dir));
    let result = match cli.command {
        Cmd::Enroll {
            server,
            code,
            device_name,
            force,
        } => enroll(&paths, &server, &code, device_name, force),
        Cmd::Run {
            project,
            task,
            simulate,
            seed,
            duration,
            no_auto_start,
            stdin_control,
        } => run(
            &paths,
            RunArgs {
                project,
                task,
                simulate,
                seed,
                duration,
                auto_start: !no_auto_start,
                stdin_control,
            },
        ),
        Cmd::Status { json } => status(&paths, json),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

fn enroll(
    paths: &Paths,
    server: &str,
    code: &str,
    device_name: Option<String>,
    force: bool,
) -> Result<ExitCode, String> {
    paths
        .ensure()
        .map_err(|e| format!("cannot create {}: {e}", paths.root.display()))?;
    let creds = credential_store(paths);
    let existing = config::load_identity(&paths.identity())?;
    let has_credential = creds
        .get(secret_names::DEVICE_CREDENTIAL)
        .map_err(|e| e.to_string())?
        .is_some();
    if existing.as_ref().is_some_and(|i| !i.revoked) && has_credential && !force {
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

    // A new enrollment is a new device: start from an empty outbox and a new key.
    if paths.outbox().exists() {
        let outbox = open_outbox(paths, creds.as_ref())?;
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
    };
    config::save_identity(&paths.identity(), &identity)?;
    println!(
        "Enrolled device {} (organization {}).",
        identity.device_id, identity.organization_id
    );
    Ok(ExitCode::SUCCESS)
}

struct RunArgs {
    project: Option<String>,
    task: Option<String>,
    simulate: bool,
    seed: Option<u64>,
    duration: Option<u64>,
    auto_start: bool,
    stdin_control: bool,
}

fn run(paths: &Paths, args: RunArgs) -> Result<ExitCode, String> {
    let mut identity = config::load_identity(&paths.identity())?
        .ok_or("this device is not enrolled; run `rd-agent enroll` first")?;
    if identity.revoked {
        return Err(
            "this device was revoked; ask your administrator for a new enrollment code".into(),
        );
    }
    let creds = credential_store(paths);
    let credential = creds
        .get(secret_names::DEVICE_CREDENTIAL)
        .map_err(|e| e.to_string())?
        .ok_or("device credential is missing; re-enroll this device")?;
    let credential = String::from_utf8(credential).map_err(|_| "device credential is corrupt")?;
    if !args.simulate {
        return Err(
            "native collectors are not part of this build; pass --simulate to run with the simulated platform"
                .into(),
        );
    }
    let seed = args.seed.unwrap_or_else(rand::random);
    let outbox = open_outbox(paths, creds.as_ref())?;
    let cfg = AgentConfig::new(identity.clone());
    let (runtime, handle) = Runtime::new(
        cfg,
        RuntimeDeps {
            clock: Arc::new(SystemClock::new()),
            input: Box::new(simulated::SimInput::new(seed)),
            foreground: Box::new(simulated::SimForeground::new(seed)),
            capturer: Arc::new(simulated::SimCapturer::new(seed)),
            transport: Arc::new(http::UreqTransport::new()),
            credentials: creds.clone(),
            outbox,
            device_credential: credential,
            seed: Some(seed),
        },
    )
    .map_err(|e| e.to_string())?;

    let ctrl = handle.clone();
    ctrlc::set_handler(move || {
        log::info!("interrupted; stopping the session");
        ctrl.send(Command::Shutdown(StopReason::User));
    })
    .map_err(|e| format!("cannot install signal handler: {e}"))?;
    if args.stdin_control {
        spawn_stdin_control(handle);
    }

    let mut opts = RunOptions::new();
    if args.auto_start {
        opts.auto_start = Some((args.project, args.task));
    }
    opts.max_duration = args.duration.map(Duration::from_secs);
    log::info!("agent running (simulated platform, seed {seed})");
    let summary = runtime.run(opts).map_err(|e| e.to_string())?;
    if summary.revoked {
        identity.revoked = true;
        config::save_identity(&paths.identity(), &identity)?;
        eprintln!("This device was revoked by your organization. Tracking has stopped and local data was erased.");
        return Ok(ExitCode::from(3));
    }
    if let Some(block) = summary.license_block {
        eprintln!(
            "{}. Your credential and {} queued event(s) are kept; tracking resumes when the licence is restored.",
            block.message(),
            summary.outbox_depth
        );
        return Ok(ExitCode::from(4));
    }
    if summary.outbox_depth > 0 {
        println!(
            "Stopped. {} event(s) are queued and will be sent next time the agent runs.",
            summary.outbox_depth
        );
    } else {
        println!("Stopped. All events were delivered.");
    }
    Ok(ExitCode::SUCCESS)
}

fn spawn_stdin_control(handle: AgentHandle) {
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let mut words = line.split_whitespace();
            let cmd = match words.next() {
                Some("start") => Command::Start {
                    project_id: words.next().map(str::to_owned),
                    task_id: words.next().map(str::to_owned),
                },
                Some("pause") => Command::Pause,
                Some("resume") => Command::Resume,
                Some("stop") => Command::Stop(StopReason::User),
                Some("quit") | Some("exit") => Command::Shutdown(StopReason::User),
                Some(other) => {
                    eprintln!("unknown command {other:?} (start [project] [task] | pause | resume | stop | quit)");
                    continue;
                }
                None => continue,
            };
            let quit = matches!(cmd, Command::Shutdown(_));
            if !handle.send(cmd) || quit {
                break;
            }
        }
    });
}

fn status(paths: &Paths, json: bool) -> Result<ExitCode, String> {
    let identity = config::load_identity(&paths.identity())?;
    let creds = credential_store(paths);
    let enrolled = creds
        .get(secret_names::DEVICE_CREDENTIAL)
        .map_err(|e| e.to_string())?
        .is_some();
    let stored = if paths.outbox().exists()
        && creds.get(secret_names::OUTBOX_KEY).ok().flatten().is_some()
    {
        let outbox = open_outbox(paths, creds.as_ref())?;
        Some(stored_status(&outbox).map_err(|e| e.to_string())?)
    } else {
        None
    };
    if json {
        let v = serde_json::json!({
            "data_dir": paths.root,
            "enrolled": enrolled && identity.as_ref().is_some_and(|i| !i.revoked),
            "identity": identity.as_ref().map(|i| serde_json::json!({
                "server_url": i.server_url,
                "device_id": i.device_id,
                "user_id": i.user_id,
                "organization_id": i.organization_id,
                "policy_key_id": i.policy_signing_key.key_id,
                "revoked": i.revoked,
            })),
            "local": stored,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?
        );
        return Ok(ExitCode::SUCCESS);
    }
    println!("Data directory: {}", paths.root.display());
    match &identity {
        None => println!("Enrollment:     not enrolled"),
        Some(i) if i.revoked => println!("Enrollment:     REVOKED (device {})", i.device_id),
        Some(i) => {
            println!(
                "Enrollment:     device {} · organization {} · {}",
                i.device_id,
                i.organization_id,
                if enrolled {
                    "credential present"
                } else {
                    "credential MISSING"
                }
            );
            println!("Server:         {}", i.server_url);
        }
    }
    let Some(s) = stored else {
        println!("Local data:     none");
        return Ok(ExitCode::SUCCESS);
    };
    if let Some(a) = &s.agent {
        println!(
            "Session:        {}{}{}",
            a.state,
            a.session_id
                .map(|id| format!(" · {id}"))
                .unwrap_or_default(),
            a.project_id
                .as_deref()
                .map(|p| format!(" · project {p}"))
                .unwrap_or_default()
        );
        println!(
            "Policy:         revision {} ({}) · idle threshold {} s · screenshots {}",
            a.policy_revision,
            a.policy_source,
            a.idle_threshold_seconds,
            if a.screenshots_enabled { "ON" } else { "off" }
        );
        if let Some(msg) = &a.tracking_unavailable_message {
            println!("Notice:         {msg}");
        }
        if let Some(l) = &a.license {
            println!(
                "Licence:        {}{}",
                serde_json::to_value(l.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default(),
                l.grace_ends_at
                    .map(|t| format!(" (grace ends {})", rd_agent_core::ts::format(&t)))
                    .unwrap_or_default()
            );
        }
        println!(
            "Last update:    {}",
            rd_agent_core::ts::format(&a.updated_at)
        );
    }
    if let Some(sync) = &s.sync {
        println!(
            "Sync:           last success {} · {}",
            sync.last_success_at
                .map(|t| rd_agent_core::ts::format(&t))
                .unwrap_or_else(|| "never".into()),
            sync.last_error.as_deref().unwrap_or("no errors")
        );
    }
    println!(
        "Outbox:         {} event(s) queued · last sequence {}",
        s.outbox_depth, s.last_sequence
    );
    for (t, n) in &s.outbox_by_type {
        println!("                {n:>6} {t}");
    }
    if !s.recent_rejections.is_empty() {
        println!("Recent rejections:");
        for r in &s.recent_rejections {
            println!("  {} {} {}", r.at, r.event_type, r.reason);
        }
    }
    Ok(ExitCode::SUCCESS)
}
