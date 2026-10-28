//! Encrypted, durable SQLite outbox (system design §8, "Outbox").
//!
//! * Every event is written here before it counts as emitted.
//! * The whole envelope is sealed with ChaCha20-Poly1305 under a 32-byte key supplied by
//!   an [`OutboxKeyProvider`] (the OS keychain in production). The associated data binds
//!   each ciphertext to its `event_id`, so rows cannot be swapped.
//! * `sequence` is allocated in the same transaction as the insert from a persisted
//!   counter: strictly increasing per device, across restarts.
//! * Storage cap: when over [`OutboxConfig::max_droppable_events`] or older than the
//!   metadata buffer, the oldest activity/app events are dropped. Lifecycle and data-gap
//!   events are never dropped.

use std::path::Path;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use chrono::{DateTime, TimeDelta, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::events::{Envelope, EventBody, Retention};
use crate::platform::{secret_names, CredentialError, CredentialStore};
use crate::policy::{PolicyCache, SignedPolicy};

/// Outbox failure.
#[derive(Debug, Error)]
pub enum OutboxError {
    /// SQLite error.
    #[error("outbox database error: {0}")]
    Db(#[from] rusqlite::Error),
    /// Serialization error.
    #[error("outbox serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    /// Encryption failed.
    #[error("outbox encryption failed")]
    Seal,
    /// Key provider failed.
    #[error(transparent)]
    Key(#[from] CredentialError),
}

/// Supplies the 32-byte outbox key.
pub trait OutboxKeyProvider {
    /// Returns the key, creating it on first use.
    fn outbox_key(&self) -> Result<[u8; 32], CredentialError>;
}

/// Key provider backed by a [`CredentialStore`] entry ([`secret_names::OUTBOX_KEY`]).
pub struct CredentialStoreKey<'a>(pub &'a dyn CredentialStore);

impl OutboxKeyProvider for CredentialStoreKey<'_> {
    fn outbox_key(&self) -> Result<[u8; 32], CredentialError> {
        if let Some(existing) = self.0.get(secret_names::OUTBOX_KEY)? {
            if let Ok(k) = <[u8; 32]>::try_from(existing.as_slice()) {
                return Ok(k);
            }
            log::warn!("stored outbox key has the wrong length; generating a new one");
        }
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        self.0.set(secret_names::OUTBOX_KEY, &k)?;
        Ok(k)
    }
}

/// A fixed key (tests).
pub struct StaticKey(pub [u8; 32]);

impl OutboxKeyProvider for StaticKey {
    fn outbox_key(&self) -> Result<[u8; 32], CredentialError> {
        Ok(self.0)
    }
}

/// Storage-cap configuration.
#[derive(Debug, Clone, Copy)]
pub struct OutboxConfig {
    /// Maximum number of droppable (activity/app) events kept.
    pub max_droppable_events: u64,
    /// Droppable events older than this are pruned by [`Outbox::prune`].
    pub max_age: TimeDelta,
}

impl Default for OutboxConfig {
    fn default() -> Self {
        Self {
            // 7 days of minute buckets plus generous app-usage headroom.
            max_droppable_events: 50_000,
            max_age: TimeDelta::days(7),
        }
    }
}

/// An event to append; the outbox assigns `sequence`.
#[derive(Debug, Clone)]
pub struct NewEvent {
    /// Organization.
    pub organization_id: String,
    /// Device.
    pub device_id: String,
    /// Session.
    pub session_id: Uuid,
    /// Applied policy revision.
    pub policy_version: i64,
    /// Body.
    pub body: EventBody,
    /// When it happened.
    pub occurred_at: DateTime<Utc>,
    /// Monotonic ms since session start.
    pub monotonic_ms: u64,
}

/// A locally recorded rejection (reason only — never the payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rejection {
    /// Rejected event id.
    pub event_id: String,
    /// Its type.
    pub event_type: String,
    /// Server-supplied reason code.
    pub reason: String,
    /// When it was recorded.
    pub at: String,
}

/// The encrypted outbox.
pub struct Outbox {
    conn: Connection,
    cipher: ChaCha20Poly1305,
    config: OutboxConfig,
}

impl std::fmt::Debug for Outbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Outbox")
            .field("config", &self.config)
            .finish()
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS events (
    sequence    INTEGER PRIMARY KEY,
    event_id    TEXT NOT NULL UNIQUE,
    event_type  TEXT NOT NULL,
    droppable   INTEGER NOT NULL,
    occurred_ms INTEGER NOT NULL,
    nonce       BLOB NOT NULL,
    ciphertext  BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS events_droppable ON events (droppable, sequence);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rejections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    reason      TEXT NOT NULL,
    at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_cache (project_key TEXT PRIMARY KEY, signed TEXT NOT NULL);
"#;

const MAX_REJECTIONS_KEPT: i64 = 1000;
const META_LAST_SEQUENCE: &str = "last_sequence";

fn aad(event_id: &str) -> Vec<u8> {
    format!("rd-outbox-v1|{event_id}").into_bytes()
}

impl Outbox {
    /// Opens (creating if needed) the outbox at `path`.
    pub fn open(
        path: &Path,
        keys: &dyn OutboxKeyProvider,
        config: OutboxConfig,
    ) -> Result<Self, OutboxError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::init(conn, keys, config)
    }

    /// Opens an in-memory outbox (tests).
    pub fn open_in_memory(
        keys: &dyn OutboxKeyProvider,
        config: OutboxConfig,
    ) -> Result<Self, OutboxError> {
        Self::init(Connection::open_in_memory()?, keys, config)
    }

    fn init(
        conn: Connection,
        keys: &dyn OutboxKeyProvider,
        config: OutboxConfig,
    ) -> Result<Self, OutboxError> {
        conn.execute_batch(SCHEMA)?;
        let key = keys.outbox_key()?;
        Ok(Self {
            conn,
            cipher: ChaCha20Poly1305::new(Key::from_slice(&key)),
            config,
        })
    }

    /// Updates the storage cap (e.g. from `offline.metadata_buffer_days`).
    pub fn set_config(&mut self, config: OutboxConfig) {
        self.config = config;
    }

    /// Current storage-cap configuration.
    pub fn config(&self) -> OutboxConfig {
        self.config
    }

    /// Appends an event, assigning the next sequence number. Enforces the count cap.
    pub fn append(&mut self, ev: NewEvent) -> Result<Envelope, OutboxError> {
        let tx = self.conn.transaction()?;
        let last: u64 = tx
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [META_LAST_SEQUENCE],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let sequence = last + 1;
        let env = Envelope {
            event_id: Uuid::new_v4(),
            organization_id: ev.organization_id,
            device_id: ev.device_id,
            session_id: ev.session_id,
            policy_version: ev.policy_version,
            body: ev.body,
            occurred_at: crate::ts::to_millis(ev.occurred_at),
            sequence,
            monotonic_ms: ev.monotonic_ms,
        };
        let plaintext = serde_json::to_vec(&env)?;
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let id = env.event_id.to_string();
        let ciphertext = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: &aad(&id),
                },
            )
            .map_err(|_| OutboxError::Seal)?;
        let droppable = env.body.retention() == Retention::Droppable;
        tx.execute(
            "INSERT INTO events (sequence, event_id, event_type, droppable, occurred_ms, nonce, ciphertext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                i64::try_from(sequence).unwrap_or(i64::MAX),
                id,
                env.body.event_type(),
                droppable,
                env.occurred_at.timestamp_millis(),
                nonce.as_slice(),
                ciphertext
            ],
        )?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![META_LAST_SEQUENCE, sequence.to_string()],
        )?;
        if droppable {
            let count: i64 =
                tx.query_row("SELECT COUNT(*) FROM events WHERE droppable = 1", [], |r| {
                    r.get(0)
                })?;
            let max = i64::try_from(self.config.max_droppable_events).unwrap_or(i64::MAX);
            if count > max {
                let n = tx.execute(
                    "DELETE FROM events WHERE sequence IN (
                        SELECT sequence FROM events WHERE droppable = 1
                        ORDER BY sequence ASC LIMIT ?1)",
                    [count - max],
                )?;
                log::warn!("outbox over cap: dropped {n} oldest activity/app events");
            }
        }
        tx.commit()?;
        Ok(env)
    }

    /// The oldest `limit` events, in sequence order. Rows that fail to decrypt or parse
    /// are removed (and recorded as rejections with reason `local_corrupt`).
    pub fn peek_oldest(&mut self, limit: usize) -> Result<Vec<Envelope>, OutboxError> {
        let rows: Vec<(String, String, Vec<u8>, Vec<u8>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT event_id, event_type, nonce, ciphertext FROM events ORDER BY sequence ASC LIMIT ?1",
            )?;
            let it = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            it.collect::<Result<_, _>>()?
        };
        let mut out = Vec::with_capacity(rows.len());
        for (id, event_type, nonce, ct) in rows {
            match self.open_row(&id, &nonce, &ct) {
                Some(env) => out.push(env),
                None => {
                    log::error!("outbox row {id} ({event_type}) failed to decrypt; discarding");
                    self.conn
                        .execute("DELETE FROM events WHERE event_id = ?1", [&id])?;
                    self.record_rejection(&id, &event_type, "local_corrupt")?;
                }
            }
        }
        Ok(out)
    }

    fn open_row(&self, id: &str, nonce: &[u8], ct: &[u8]) -> Option<Envelope> {
        if nonce.len() != 12 {
            return None;
        }
        let pt = self
            .cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ct,
                    aad: &aad(id),
                },
            )
            .ok()?;
        serde_json::from_slice(&pt).ok()
    }

    /// Deletes events by id.
    pub fn delete(&mut self, ids: &[Uuid]) -> Result<usize, OutboxError> {
        let tx = self.conn.transaction()?;
        let mut n = 0;
        {
            let mut stmt = tx.prepare("DELETE FROM events WHERE event_id = ?1")?;
            for id in ids {
                n += stmt.execute([id.to_string()])?;
            }
        }
        tx.commit()?;
        Ok(n)
    }

    /// Records a rejection reason locally (keeps the most recent 1000).
    pub fn record_rejection(
        &mut self,
        event_id: &str,
        event_type: &str,
        reason: &str,
    ) -> Result<(), OutboxError> {
        let reason: String = reason.chars().take(200).collect();
        self.conn.execute(
            "INSERT INTO rejections (event_id, event_type, reason, at) VALUES (?1, ?2, ?3, ?4)",
            params![event_id, event_type, reason, crate::ts::format(&Utc::now())],
        )?;
        self.conn.execute(
            "DELETE FROM rejections WHERE id <= (SELECT MAX(id) FROM rejections) - ?1",
            [MAX_REJECTIONS_KEPT],
        )?;
        Ok(())
    }

    /// The most recent rejections, newest first.
    pub fn rejections(&self, limit: usize) -> Result<Vec<Rejection>, OutboxError> {
        let mut stmt = self.conn.prepare(
            "SELECT event_id, event_type, reason, at FROM rejections ORDER BY id DESC LIMIT ?1",
        )?;
        let it = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok(Rejection {
                event_id: r.get(0)?,
                event_type: r.get(1)?,
                reason: r.get(2)?,
                at: r.get(3)?,
            })
        })?;
        Ok(it.collect::<Result<_, _>>()?)
    }

    /// Number of queued events.
    pub fn depth(&self) -> Result<u64, OutboxError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(u64::try_from(n).unwrap_or(0))
    }

    /// Queued events per `event_type`.
    pub fn depth_by_type(&self) -> Result<Vec<(String, u64)>, OutboxError> {
        let mut stmt = self.conn.prepare(
            "SELECT event_type, COUNT(*) FROM events GROUP BY event_type ORDER BY event_type",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
            ))
        })?;
        Ok(it.collect::<Result<_, _>>()?)
    }

    /// Last sequence number allocated (0 if none).
    pub fn last_sequence(&self) -> Result<u64, OutboxError> {
        Ok(self
            .get_meta(META_LAST_SEQUENCE)?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0))
    }

    /// Drops droppable events that occurred before `now - max_age`. Returns the count.
    pub fn prune(&mut self, now: DateTime<Utc>) -> Result<usize, OutboxError> {
        let cutoff = (now - self.config.max_age).timestamp_millis();
        let n = self.conn.execute(
            "DELETE FROM events WHERE droppable = 1 AND occurred_ms < ?1",
            [cutoff],
        )?;
        if n > 0 {
            log::warn!("outbox: pruned {n} activity/app events older than the metadata buffer");
        }
        Ok(n)
    }

    /// Reads a metadata value.
    pub fn get_meta(&self, key: &str) -> Result<Option<String>, OutboxError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    /// Writes a metadata value.
    pub fn set_meta(&mut self, key: &str, value: &str) -> Result<(), OutboxError> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Deletes a metadata value.
    pub fn delete_meta(&mut self, key: &str) -> Result<(), OutboxError> {
        self.conn
            .execute("DELETE FROM meta WHERE key = ?1", [key])?;
        Ok(())
    }

    /// Erases everything: events, rejections, metadata (including the sequence counter)
    /// and cached policies. Used on revocation and before a new enrollment.
    pub fn wipe(&mut self) -> Result<(), OutboxError> {
        self.conn.execute_batch(
            "DELETE FROM events; DELETE FROM rejections; DELETE FROM meta; DELETE FROM policy_cache;",
        )?;
        let _ = self.conn.execute_batch("VACUUM;");
        Ok(())
    }

    fn load_policy(&self, project_key: &str) -> Option<SignedPolicy> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT signed FROM policy_cache WHERE project_key = ?1",
                [project_key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        raw.and_then(|s| serde_json::from_str(&s).ok())
    }

    fn save_policy(&mut self, project_key: &str, signed: &SignedPolicy) {
        let Ok(s) = serde_json::to_string(signed) else {
            return;
        };
        if let Err(e) = self.conn.execute(
            "INSERT INTO policy_cache (project_key, signed) VALUES (?1, ?2)
             ON CONFLICT(project_key) DO UPDATE SET signed = excluded.signed",
            params![project_key, s],
        ) {
            log::warn!("could not persist policy cache: {e}");
        }
    }
}

/// An outbox shared between the tick thread and the network thread.
pub type SharedOutbox = std::sync::Arc<std::sync::Mutex<Outbox>>;

/// Locks a shared outbox, recovering from poisoning.
pub fn lock(o: &SharedOutbox) -> std::sync::MutexGuard<'_, Outbox> {
    o.lock().unwrap_or_else(|e| e.into_inner())
}

/// [`PolicyCache`] persisted in the outbox database.
pub struct OutboxPolicyCache(pub SharedOutbox);

impl PolicyCache for OutboxPolicyCache {
    fn load(&self, project_key: &str) -> Option<SignedPolicy> {
        lock(&self.0).load_policy(project_key)
    }
    fn save(&mut self, project_key: &str, signed: &SignedPolicy) {
        lock(&self.0).save_policy(project_key, signed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{
        ActivityBucket, DataQuality, Empty, SessionStarted, SessionStopped, StopReason,
    };
    use chrono::TimeZone;

    const KEY: StaticKey = StaticKey([42u8; 32]);

    fn new_event(body: EventBody) -> NewEvent {
        NewEvent {
            organization_id: "org".into(),
            device_id: "dev".into(),
            session_id: Uuid::nil(),
            policy_version: 1,
            body,
            occurred_at: Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap(),
            monotonic_ms: 0,
        }
    }

    fn bucket(min: u32) -> EventBody {
        EventBody::ActivityBucket(ActivityBucket {
            bucket_start: Utc.with_ymd_and_hms(2026, 10, 28, 9, min, 0).unwrap(),
            active_seconds: 30,
            idle_seconds: 0,
            keyboard_count: 1,
            mouse_count: 1,
            data_quality: DataQuality::Ok,
        })
    }

    fn started() -> EventBody {
        EventBody::SessionStarted(SessionStarted {
            project_id: Some("secret-project-name".into()),
            task_id: None,
        })
    }

    #[test]
    fn append_peek_delete_in_sequence_order() {
        let mut o = Outbox::open_in_memory(&KEY, OutboxConfig::default()).unwrap();
        let a = o.append(new_event(started())).unwrap();
        let b = o.append(new_event(bucket(1))).unwrap();
        let c = o
            .append(new_event(EventBody::SessionResumed(Empty {})))
            .unwrap();
        assert_eq!((a.sequence, b.sequence, c.sequence), (1, 2, 3));
        assert_eq!(a.event_id.get_version_num(), 4);
        let got = o.peek_oldest(2).unwrap();
        assert_eq!(got, vec![a.clone(), b.clone()]);
        o.delete(&[a.event_id]).unwrap();
        let got = o.peek_oldest(10).unwrap();
        assert_eq!(got, vec![b, c]);
        assert_eq!(o.depth().unwrap(), 2);
    }

    #[test]
    fn payloads_are_encrypted_at_rest_and_wrong_key_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        {
            let mut o = Outbox::open(&path, &KEY, OutboxConfig::default()).unwrap();
            o.append(new_event(started())).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        let ct: Vec<u8> = conn
            .query_row("SELECT ciphertext FROM events", [], |r| r.get(0))
            .unwrap();
        let needle = b"secret-project-name";
        assert!(!ct.windows(needle.len()).any(|w| w == needle));
        drop(conn);
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(needle.len()).any(|w| w == needle));

        let mut wrong =
            Outbox::open(&path, &StaticKey([1u8; 32]), OutboxConfig::default()).unwrap();
        assert!(wrong.peek_oldest(10).unwrap().is_empty());
        assert_eq!(wrong.rejections(10).unwrap()[0].reason, "local_corrupt");
    }

    #[test]
    fn sequence_and_events_persist_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        let first = {
            let mut o = Outbox::open(&path, &KEY, OutboxConfig::default()).unwrap();
            let e1 = o.append(new_event(started())).unwrap();
            let e2 = o.append(new_event(bucket(1))).unwrap();
            o.delete(&[e1.event_id, e2.event_id]).unwrap();
            o.append(new_event(bucket(2))).unwrap()
        };
        let mut o = Outbox::open(&path, &KEY, OutboxConfig::default()).unwrap();
        assert_eq!(o.last_sequence().unwrap(), 3);
        let next = o.append(new_event(bucket(3))).unwrap();
        assert_eq!(
            next.sequence, 4,
            "sequence must not restart after deletes or reopen"
        );
        let replay = o.peek_oldest(10).unwrap();
        assert_eq!(replay, vec![first, next]);
    }

    #[test]
    fn cap_drops_oldest_droppable_and_never_lifecycle() {
        let cfg = OutboxConfig {
            max_droppable_events: 3,
            max_age: TimeDelta::days(7),
        };
        let mut o = Outbox::open_in_memory(&KEY, cfg).unwrap();
        o.append(new_event(started())).unwrap();
        for m in 0..6 {
            o.append(new_event(bucket(m))).unwrap();
        }
        o.append(new_event(EventBody::SessionStopped(SessionStopped {
            reason: StopReason::User,
        })))
        .unwrap();
        let all = o.peek_oldest(100).unwrap();
        let types: Vec<_> = all.iter().map(|e| e.body.event_type()).collect();
        assert_eq!(
            types,
            vec![
                "session.started.v1",
                "activity_bucket.v1",
                "activity_bucket.v1",
                "activity_bucket.v1",
                "session.stopped.v1"
            ]
        );
        // The newest three buckets survive.
        let seqs: Vec<_> = all.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs, vec![1, 5, 6, 7, 8]);
    }

    #[test]
    fn prune_by_age_keeps_lifecycle() {
        let mut o = Outbox::open_in_memory(&KEY, OutboxConfig::default()).unwrap();
        o.append(new_event(started())).unwrap();
        o.append(new_event(bucket(1))).unwrap();
        let t0 = Utc.with_ymd_and_hms(2026, 10, 28, 9, 0, 0).unwrap();
        assert_eq!(o.prune(t0 + TimeDelta::days(6)).unwrap(), 0);
        assert_eq!(o.prune(t0 + TimeDelta::days(8)).unwrap(), 1);
        assert_eq!(
            o.depth_by_type().unwrap(),
            vec![("session.started.v1".into(), 1)]
        );
    }

    #[test]
    fn wipe_clears_everything_including_sequence() {
        let mut o = Outbox::open_in_memory(&KEY, OutboxConfig::default()).unwrap();
        o.append(new_event(started())).unwrap();
        o.record_rejection("x", "activity_bucket.v1", "bad")
            .unwrap();
        o.set_meta("k", "v").unwrap();
        o.wipe().unwrap();
        assert_eq!(o.depth().unwrap(), 0);
        assert!(o.rejections(10).unwrap().is_empty());
        assert_eq!(o.get_meta("k").unwrap(), None);
        assert_eq!(o.append(new_event(bucket(1))).unwrap().sequence, 1);
    }

    #[test]
    fn credential_store_key_is_created_once() {
        let store = crate::testing::MemoryCredentials::default();
        let k1 = CredentialStoreKey(&store).outbox_key().unwrap();
        let k2 = CredentialStoreKey(&store).outbox_key().unwrap();
        assert_eq!(k1, k2);
        assert_ne!(k1, [0u8; 32]);
    }

    #[test]
    fn policy_cache_round_trip() {
        let shared: SharedOutbox = std::sync::Arc::new(std::sync::Mutex::new(
            Outbox::open_in_memory(&KEY, OutboxConfig::default()).unwrap(),
        ));
        let mut cache = OutboxPolicyCache(shared);
        let signed = SignedPolicy {
            payload_b64: "cA==".into(),
            signature_b64: "cw==".into(),
            key_id: "k".into(),
        };
        assert!(cache.load("p").is_none());
        cache.save("p", &signed);
        assert_eq!(cache.load("p"), Some(signed));
    }
}
