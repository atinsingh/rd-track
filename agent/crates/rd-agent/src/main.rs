//! `rd-agent`: the RoundDigital Track desktop agent (headless) and developer CLI.
//!
//! ```text
//! rd-agent enroll --server https://track.example.com --code ABCDEFGHJK
//! rd-agent run --project <id>            # native collectors (Windows, macOS)
//! rd-agent run --project <id> --simulate # simulated platform (any OS, CI)
//! rd-agent status
//! ```

use std::io::BufRead;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use rd_agent::config::{self, Paths};
use rd_agent::setup::{credential_store, open_outbox};
use rd_agent::{http, native, setup, simulated};
use rd_agent_core::clock::SystemClock;
use rd_agent_core::events::StopReason;
use rd_agent_core::platform::{secret_names, ForegroundApp, InputCounter, ScreenCapturer};
use rd_agent_core::runtime::{
    stored_status, AgentConfig, AgentHandle, Command, RunOptions, Runtime, RuntimeDeps,
};

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
        /// Use the simulated platform instead of the native collectors (required on
        /// Linux, which has no native collectors).
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
    let creds = credential_store(paths);
    let identity = setup::enroll(paths, creds.as_ref(), server, code, device_name, force)?;
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
    let creds = credential_store(paths);
    let (identity, credential) = setup::load_for_run(paths, creds.as_ref())?;
    let seed = args.seed.unwrap_or_else(rand::random);
    type Collectors = (
        Box<dyn InputCounter>,
        Box<dyn ForegroundApp>,
        Arc<dyn ScreenCapturer>,
        &'static str,
    );
    let (input, foreground, capturer, platform_name): Collectors = if args.simulate {
        (
            Box::new(simulated::SimInput::new(seed)),
            Box::new(simulated::SimForeground::new(seed)),
            Arc::new(simulated::SimCapturer::new(seed)),
            "simulated platform",
        )
    } else {
        let n = native::platform().ok_or(
            "this OS has no native collectors (Linux is a development target); pass --simulate",
        )?;
        (n.input, n.foreground, n.capturer, "native collectors")
    };
    let outbox = open_outbox(paths, creds.as_ref())?;
    let cfg = AgentConfig::new(identity.clone());
    let (runtime, handle) = Runtime::new(
        cfg,
        RuntimeDeps {
            clock: Arc::new(SystemClock::new()),
            input,
            foreground,
            capturer,
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
    log::info!("agent running ({platform_name}, seed {seed})");
    let summary = runtime.run(opts).map_err(|e| e.to_string())?;
    if summary.revoked {
        setup::mark_revoked(paths, &identity)?;
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
