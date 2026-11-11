//! Conditional metadata reads share the native profile repository and SQLite snapshot.
pub(crate) mod contracts;
pub(super) mod projection;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub(super) const REVISION_KEY: &str = "settings.profiles.revision.v1";
pub(super) const MAX_STORAGE_BYTES: usize = super::MAX_FILE_BYTES * super::MAX_PROFILES + 65_536;

pub(crate) fn observe(
    conn: &Connection,
    request: contracts::Observe,
) -> AppResult<contracts::Observation> {
    let tx = conn.unchecked_transaction()?;
    // Check the stored byte length before returning a potentially large string to Rust.
    let raw: Option<Option<String>> = tx.query_row(
        "SELECT CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ?2 THEN value END FROM settings WHERE key = ?1",
        rusqlite::params![super::KEY, MAX_STORAGE_BYTES as i64], |row| row.get(0),
    ).optional()?;
    let items = match raw {
        None => Vec::new(),
        Some(Some(raw)) => projection::items(&raw)?,
        Some(None) => return Err(AppError::validation("profiles.invalidStorage")),
    };
    let nonce: Option<Option<String>> = tx.query_row("SELECT CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) = 36 THEN value END FROM settings WHERE key = ?1", [REVISION_KEY], |row| row.get(0)).optional()?;
    let nonce = match nonce {
        None => None,
        Some(Some(nonce)) => Some(nonce),
        Some(None) => return Err(AppError::validation("profiles.invalidStorage")),
    };
    if let Some(nonce) = &nonce {
        if !uuid::Uuid::parse_str(nonce).is_ok_and(|id| !id.is_nil() && id.to_string() == *nonce) {
            return Err(AppError::validation("profiles.invalidStorage"));
        }
    }
    // A retained nonce must not hide metadata changes made by a historical native writer.
    let bytes = serde_json::to_vec(&items)?;
    let revision = format!(
        "p1:{}:{:x}",
        nonce.as_deref().unwrap_or("legacy"),
        Sha256::digest(bytes)
    );
    let changed = request.revision.as_ref() != Some(&revision);
    let response = contracts::Observation {
        version: 1,
        revision: revision.clone(),
        changed,
        snapshot: changed.then_some(contracts::Snapshot {
            version: 1,
            revision,
            items,
        }),
    };
    if serde_json::to_vec(&response)?.len() > 32 * 1024 {
        return Err(AppError::validation("profiles.invalidStorage"));
    }
    tx.commit()?;
    Ok(response)
}

#[cfg(test)]
mod tests;
