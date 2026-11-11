//! Persist preferences and their concurrency token in the same SQLite transaction.
use crate::{error::AppResult, settings::Settings};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

const REVISION_KEY: &str = "settings.preferences.revision.v1";

pub(super) fn revision(conn: &Connection, current: &Settings) -> AppResult<String> {
    let saved: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [REVISION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    // Opening an old database must not write to it. Before its first commit the
    // token deterministically identifies the loaded, sanitized preferences.
    match saved {
        Some(revision) => Ok(revision),
        None => Ok(format!(
            "legacy:{:x}",
            Sha256::digest(serde_json::to_vec(current)?)
        )),
    }
}

#[cfg(test)]
pub(super) fn save(conn: &Connection, next: &Settings) -> AppResult<String> {
    save_with(conn, next, |_| Ok(()))
}

pub(super) fn save_with(
    conn: &Connection,
    next: &Settings,
    extra: impl FnOnce(&Connection) -> AppResult<()>,
) -> AppResult<String> {
    let revision = uuid::Uuid::new_v4().to_string();
    let transaction = conn.unchecked_transaction()?;
    crate::db::settings::save(&transaction, next)?;
    transaction.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![REVISION_KEY, revision, crate::models::now_ms()],
    )?;
    extra(&transaction)?;
    transaction.commit()?;
    Ok(revision)
}

#[cfg(test)]
#[path = "repository_tests.rs"]
mod tests;
