//! One transactional document in the database category; no arbitrary paths.
use super::contracts::{self, Draft, Snapshot};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};

const KEY: &str = "editor.drafts.v1";
// Escaped JSON may be six times the UTF-8 text size.
const MAX_BYTES: i64 = 72 * 1024 * 1024;

pub(super) fn read(conn: &Connection) -> AppResult<Snapshot> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1 AND length(CAST(value AS BLOB)) <= ?2",
            params![KEY, MAX_BYTES],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
            [KEY],
            |row| row.get(0),
        )?;
        return if exists {
            Err(AppError::validation("editor.recoveryInvalid"))
        } else {
            Ok(Snapshot::default())
        };
    };
    let value: Snapshot =
        serde_json::from_str(&raw).map_err(|_| AppError::validation("editor.recoveryInvalid"))?;
    contracts::validate(&value.drafts)?;
    if uuid::Uuid::parse_str(&value.revision).is_err() {
        return Err(AppError::validation("editor.recoveryInvalid"));
    }
    Ok(value)
}

fn write(conn: &Connection, value: &Snapshot) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key,value,updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![KEY, serde_json::to_string(value)?, crate::models::now_ms()],
    )?;
    Ok(())
}

pub(super) fn save(conn: &Connection, revision: &str, drafts: Vec<Draft>) -> AppResult<String> {
    contracts::validate(&drafts)?;
    let tx = conn.unchecked_transaction()?;
    if !crate::db::settings::load(&tx)?.editor_draft_recovery {
        return Err(AppError::validation("editor.recoveryDisabled"));
    }
    let current = read(&tx)?;
    if current.revision != revision {
        return Err(AppError::validation("editor.recoveryChanged"));
    }
    let next = uuid::Uuid::new_v4().to_string();
    write(
        &tx,
        &Snapshot {
            revision: next.clone(),
            drafts,
        },
    )?;
    tx.commit()?;
    Ok(next)
}

/// Called inside the preference transaction: deletion and revocation are atomic.
/// A tombstone fences any old request still waiting in a worker queue.
pub(crate) fn clear(conn: &Connection) -> AppResult<()> {
    // Explicit opt-out must also be able to clear malformed old recovery data.
    let revision = uuid::Uuid::new_v4().to_string();
    write(
        conn,
        &Snapshot {
            revision,
            drafts: Vec::new(),
        },
    )
}
