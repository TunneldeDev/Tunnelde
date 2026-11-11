//! Existing profile rows, bounded before decoding; no parallel profile registry.
use super::{observation, SettingsProfile, KEY, MAX_PROFILES};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ACTIVE_KEY: &str = "settings.profiles.active.v1";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Active {
    version: u8,
    profile_id: String,
}

pub(super) struct Snapshot {
    pub profiles: Vec<SettingsProfile>,
    pub revision: String,
    pub active_id: Option<String>,
}

fn invalid() -> AppError {
    AppError::validation("profiles.invalidStorage")
}

fn text(conn: &Connection, key: &str, limit: usize) -> AppResult<Option<String>> {
    let raw: Option<Option<String>> = conn.query_row(
        "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB)) <= ?2 THEN value END FROM settings WHERE key=?1",
        params![key, limit as i64], |row| row.get(0),
    ).optional()?;
    match raw {
        None => Ok(None),
        Some(Some(raw)) => Ok(Some(raw)),
        Some(None) => Err(invalid()),
    }
}

fn active(conn: &Connection) -> AppResult<Option<String>> {
    let Some(raw) = text(conn, ACTIVE_KEY, 1024)? else {
        return Ok(None);
    };
    let active: Active = serde_json::from_str(&raw).map_err(|_| invalid())?;
    if active.version != 1
        || active.profile_id.is_empty()
        || active.profile_id.len() > 128
        || active.profile_id.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(Some(active.profile_id))
}

pub(super) fn select(conn: &Connection, id: Option<&str>) -> AppResult<()> {
    match id {
        Some(id) => {
            let raw = serde_json::to_string(&Active {
                version: 1,
                profile_id: id.into(),
            })?;
            conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![ACTIVE_KEY,raw,crate::models::now_ms()])?;
        }
        None => {
            conn.execute("DELETE FROM settings WHERE key=?1", [ACTIVE_KEY])?;
        }
    }
    Ok(())
}

/// Caller holds the shared DB lock, optionally inside its settings transaction.
pub(super) fn read(conn: &Connection) -> AppResult<Snapshot> {
    let raw = text(conn, KEY, observation::MAX_STORAGE_BYTES)?.unwrap_or_else(|| "[]".into());
    // Metadata visitor caps 32 entries before materializing preference bodies.
    // Preserve the existing total storage bound: older native saves did not
    // impose the import-file limit on each individual saved profile.
    observation::projection::items(&raw)?;
    let profiles: Vec<SettingsProfile> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let nonce = text(conn, observation::REVISION_KEY, 36)?;
    if nonce.as_ref().is_some_and(|value| {
        !uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == *value)
    }) {
        return Err(invalid());
    }
    // Full stored bytes detect legacy content changes even with unchanged metadata.
    // The saved nonce also detects same-content ABA by current writers.
    let revision = format!(
        "pc1:{:x}",
        Sha256::digest(serde_json::to_vec(&(&raw, &nonce))?)
    );
    let active_id = active(conn)?.filter(|id| profiles.iter().any(|profile| &profile.id == id));
    Ok(Snapshot {
        profiles,
        revision,
        active_id,
    })
}

pub(super) fn check(conn: &Connection, expected: &str) -> AppResult<Snapshot> {
    let current = read(conn)?;
    if expected != current.revision {
        return Err(AppError::validation("profiles.conflict"));
    }
    Ok(current)
}

pub(super) fn save(conn: &Connection, profiles: &[SettingsProfile]) -> AppResult<()> {
    let raw = serde_json::to_string(profiles)?;
    if profiles.len() > MAX_PROFILES || raw.len() > observation::MAX_STORAGE_BYTES {
        return Err(AppError::validation("profiles.storageTooLarge"));
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![KEY,raw,crate::models::now_ms()])?;
    tx.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![observation::REVISION_KEY,uuid::Uuid::new_v4().to_string(),crate::models::now_ms()])?;
    if active(&tx)?.is_some_and(|id| !profiles.iter().any(|profile| profile.id == id)) {
        select(&tx, None)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
