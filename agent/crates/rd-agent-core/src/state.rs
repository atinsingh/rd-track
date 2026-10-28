//! The work-session state machine (system design §6.2).
//!
//! ```text
//!             start                pause                stop
//!   Idle ───────────► Active ◄──────────────► Paused ──────────► Stopped
//!                       │  resume                                  ▲
//!                       │ wall-clock jump (sleep)                  │
//!                       ▼                                          │
//!                   Suspended ── wake ──► Active      (stop if policy/revoked)
//! ```
//!
//! The machine is pure: it validates transitions and returns the lifecycle event (if
//! any) that the transition must emit. Collectors consult [`SessionMachine::is_capturing`]
//! on every tick; only `Active` captures.

use chrono::{DateTime, Utc};
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

use crate::events::{
    Empty, EventBody, PauseReason, SessionPaused, SessionStarted, SessionStopped, StopReason,
};

/// Agent-side session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// No session has been started since the agent launched.
    Idle,
    /// A session is running and capture is on.
    Active,
    /// A session is open but paused; nothing is captured.
    Paused(PauseReason),
    /// The machine is asleep (transient; detected on wake).
    Suspended,
    /// The last session ended.
    Stopped(StopReason),
}

impl SessionState {
    /// Short lower-case name (`idle`, `active`, `paused`, `suspended`, `stopped`).
    pub fn name(&self) -> &'static str {
        match self {
            SessionState::Idle => "idle",
            SessionState::Active => "active",
            SessionState::Paused(_) => "paused",
            SessionState::Suspended => "suspended",
            SessionState::Stopped(_) => "stopped",
        }
    }
}

/// Details of the open session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    /// Agent-generated session id.
    pub id: Uuid,
    /// Project booked to the session.
    pub project_id: Option<String>,
    /// Task booked to the session.
    pub task_id: Option<String>,
    /// Wall time the session started.
    pub started_at: DateTime<Utc>,
    /// Monotonic reading that corresponds to `monotonic_ms = 0`.
    pub mono_origin: Duration,
}

/// An illegal transition was requested.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("cannot {action} while {state}")]
pub struct TransitionError {
    /// What was attempted.
    pub action: &'static str,
    /// The state at the time.
    pub state: &'static str,
}

/// The result of a successful transition.
#[derive(Debug, Clone, PartialEq)]
pub struct Transition {
    /// State before.
    pub from: SessionState,
    /// State after.
    pub to: SessionState,
    /// Lifecycle event to record, if the transition emits one.
    pub event: Option<EventBody>,
}

/// The session state machine.
#[derive(Debug, Clone)]
pub struct SessionMachine {
    state: SessionState,
    session: Option<SessionInfo>,
}

impl Default for SessionMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionMachine {
    /// A machine in `Idle`.
    pub fn new() -> Self {
        Self {
            state: SessionState::Idle,
            session: None,
        }
    }

    /// Restores a machine with an open session (crash recovery).
    pub fn restore(session: SessionInfo, state: SessionState) -> Self {
        Self {
            state,
            session: Some(session),
        }
    }

    /// Current state.
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// The current (or last) session.
    pub fn session(&self) -> Option<&SessionInfo> {
        self.session.as_ref()
    }

    /// `true` only in `Active`: the single gate every collector checks.
    pub fn is_capturing(&self) -> bool {
        self.state == SessionState::Active
    }

    /// `true` while a session is open (`Active`, `Paused`, `Suspended`).
    pub fn is_open(&self) -> bool {
        matches!(
            self.state,
            SessionState::Active | SessionState::Paused(_) | SessionState::Suspended
        )
    }

    fn err(&self, action: &'static str) -> TransitionError {
        TransitionError {
            action,
            state: self.state.name(),
        }
    }

    fn go(&mut self, to: SessionState, event: Option<EventBody>) -> Transition {
        let from = std::mem::replace(&mut self.state, to);
        Transition { from, to, event }
    }

    /// `Idle | Stopped → Active` with a fresh session id.
    pub fn start(
        &mut self,
        project_id: Option<String>,
        task_id: Option<String>,
        now: DateTime<Utc>,
        mono: Duration,
    ) -> Result<Transition, TransitionError> {
        if self.is_open() {
            return Err(self.err("start"));
        }
        self.session = Some(SessionInfo {
            id: Uuid::new_v4(),
            project_id: project_id.clone(),
            task_id: task_id.clone(),
            started_at: now,
            mono_origin: mono,
        });
        Ok(self.go(
            SessionState::Active,
            Some(EventBody::SessionStarted(SessionStarted {
                project_id,
                task_id,
            })),
        ))
    }

    /// `Active → Paused(reason)`.
    pub fn pause(&mut self, reason: PauseReason) -> Result<Transition, TransitionError> {
        if self.state != SessionState::Active {
            return Err(self.err("pause"));
        }
        Ok(self.go(
            SessionState::Paused(reason),
            Some(EventBody::SessionPaused(SessionPaused { reason })),
        ))
    }

    /// `Paused → Active`.
    pub fn resume(&mut self) -> Result<Transition, TransitionError> {
        if !matches!(self.state, SessionState::Paused(_)) {
            return Err(self.err("resume"));
        }
        Ok(self.go(
            SessionState::Active,
            Some(EventBody::SessionResumed(Empty {})),
        ))
    }

    /// `Active | Paused | Suspended → Stopped(reason)`.
    ///
    /// `Revoked` stops produce no event: the server already knows (§8).
    pub fn stop(&mut self, reason: StopReason) -> Result<Transition, TransitionError> {
        if !self.is_open() {
            return Err(self.err("stop"));
        }
        let event = (reason != StopReason::Revoked)
            .then_some(EventBody::SessionStopped(SessionStopped { reason }));
        Ok(self.go(SessionState::Stopped(reason), event))
    }

    /// `Active → Suspended` (no event; the data gap is emitted on wake).
    pub fn suspend(&mut self) -> Result<Transition, TransitionError> {
        if self.state != SessionState::Active {
            return Err(self.err("suspend"));
        }
        Ok(self.go(SessionState::Suspended, None))
    }

    /// `Suspended → Active` (no lifecycle event; the caller emits `data_gap.v1`).
    pub fn wake(&mut self) -> Result<Transition, TransitionError> {
        if self.state != SessionState::Suspended {
            return Err(self.err("wake"));
        }
        Ok(self.go(SessionState::Active, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap()
    }

    #[test]
    fn full_lifecycle_emits_events_in_order() {
        let mut m = SessionMachine::new();
        assert_eq!(m.state(), SessionState::Idle);
        assert!(!m.is_capturing());

        let t = m
            .start(Some("p1".into()), None, now(), Duration::from_secs(5))
            .unwrap();
        assert_eq!(t.from, SessionState::Idle);
        assert_eq!(
            t.event,
            Some(EventBody::SessionStarted(SessionStarted {
                project_id: Some("p1".into()),
                task_id: None
            }))
        );
        assert!(m.is_capturing());
        let id = m.session().unwrap().id;
        assert_eq!(id.get_version_num(), 4);

        let t = m.pause(PauseReason::User).unwrap();
        assert_eq!(t.to, SessionState::Paused(PauseReason::User));
        assert!(!m.is_capturing());
        assert!(m.is_open());

        let t = m.resume().unwrap();
        assert_eq!(t.event, Some(EventBody::SessionResumed(Empty {})));
        assert!(m.is_capturing());

        let t = m.suspend().unwrap();
        assert!(t.event.is_none());
        assert!(!m.is_capturing());
        let t = m.wake().unwrap();
        assert!(t.event.is_none());
        assert!(m.is_capturing());

        let t = m.stop(StopReason::User).unwrap();
        assert_eq!(
            t.event,
            Some(EventBody::SessionStopped(SessionStopped {
                reason: StopReason::User
            }))
        );
        assert!(!m.is_capturing());
        assert!(!m.is_open());
        assert_eq!(m.session().unwrap().id, id);
    }

    #[test]
    fn restart_after_stop_creates_new_session() {
        let mut m = SessionMachine::new();
        m.start(None, None, now(), Duration::ZERO).unwrap();
        let first = m.session().unwrap().id;
        m.stop(StopReason::User).unwrap();
        m.start(None, None, now(), Duration::ZERO).unwrap();
        assert_ne!(m.session().unwrap().id, first);
    }

    #[test]
    fn illegal_transitions_are_rejected_without_side_effects() {
        let mut m = SessionMachine::new();
        assert!(m.pause(PauseReason::User).is_err());
        assert!(m.resume().is_err());
        assert!(m.stop(StopReason::User).is_err());
        assert!(m.wake().is_err());
        assert!(m.suspend().is_err());
        assert_eq!(m.state(), SessionState::Idle);

        m.start(None, None, now(), Duration::ZERO).unwrap();
        let e = m.start(None, None, now(), Duration::ZERO).unwrap_err();
        assert_eq!(e.state, "active");
        assert!(m.resume().is_err());
        m.pause(PauseReason::User).unwrap();
        assert!(m.pause(PauseReason::User).is_err());
        assert!(m.suspend().is_err());
        m.stop(StopReason::Shutdown).unwrap();
        assert!(m.resume().is_err());
        assert!(m.pause(PauseReason::User).is_err());
    }

    #[test]
    fn revoked_stop_emits_nothing_and_suspended_can_stop() {
        let mut m = SessionMachine::new();
        m.start(None, None, now(), Duration::ZERO).unwrap();
        m.suspend().unwrap();
        let t = m.stop(StopReason::Revoked).unwrap();
        assert!(t.event.is_none());
        assert_eq!(m.state(), SessionState::Stopped(StopReason::Revoked));
    }
}
