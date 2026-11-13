//! Persisted rules only. The domain service coordinates these commits with runtime admission.
use super::contract::{ForwardRule, RevisionedRule};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

fn key(id: &str) -> String {
    format!("forward:{id}")
}
fn version_key(id: &str) -> String {
    format!("forward-version:{id}")
}
fn revision(raw: &str, stored: Option<String>) -> AppResult<String> {
    match stored {
        Some(value) => {
            let value: String = serde_json::from_str(&value)?;
            if value.is_empty() || value.len() > 128 {
                return Err(AppError::validation("forward.invalid"));
            }
            Ok(value)
        }
        // Existing rules remain readable without a migration write. Their first save
        // creates a fresh UUID, so repeated edits and delete/recreate cannot reuse it.
        None => Ok(format!("legacy:{:x}", Sha256::digest(raw.as_bytes()))),
    }
}
fn find(conn: &Connection, id: &str) -> AppResult<Option<RevisionedRule>> {
    let value: Option<(String, Option<String>)> = conn.query_row(
        "SELECT r.value,v.value FROM settings r LEFT JOIN settings v ON v.key=?2 WHERE r.key=?1",
        rusqlite::params![key(id), version_key(id)],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    value
        .map(|(raw, token)| {
            Ok(RevisionedRule {
                revision: revision(&raw, token)?,
                rule: serde_json::from_str(&raw)?,
            })
        })
        .transpose()
}
fn check(conn: &Connection, id: &str, expected: Option<&str>) -> AppResult<()> {
    if let Some(expected) = expected {
        if find(conn, id)?
            .as_ref()
            .is_none_or(|current| current.revision != expected)
        {
            return Err(AppError::validation("forward.changed"));
        }
    }
    Ok(())
}
pub(super) fn list(db: &Database) -> AppResult<Vec<RevisionedRule>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT r.value,v.value FROM settings r LEFT JOIN settings v ON v.key='forward-version:' || substr(r.key,9) WHERE r.key LIKE 'forward:%' ORDER BY r.updated_at DESC",
        )?;
        let raw = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))?;
        let mut result = Vec::new();
        for item in raw {
            let (raw, token) = item?;
            result.push(RevisionedRule {
                rule: serde_json::from_str(&raw)?,
                revision: revision(&raw, token)?,
            });
        }
        Ok(result)
    })
}

pub(super) fn page(
    db: &Database,
    after: &str,
    limit: usize,
    check: &impl Fn() -> AppResult<()>,
) -> AppResult<Vec<RevisionedRule>> {
    db.with(|conn| {
        check()?;
        // SQL bounds individual blobs before allocating them in Rust. The
        // continuation uses the stored key, never timestamps or mutable names.
        let mut stmt = conn.prepare(
            "SELECT CASE WHEN length(CAST(r.key AS BLOB))<=136 THEN r.key END,
             CASE WHEN length(CAST(r.value AS BLOB))<=8192 THEN r.value END,
             CASE WHEN length(CAST(v.value AS BLOB))<=1024 THEN v.value END, v.key IS NOT NULL
             FROM settings r LEFT JOIN settings v ON v.key='forward-version:' || substr(r.key,9)
             WHERE r.key LIKE 'forward:%' AND r.key>?1 ORDER BY r.key COLLATE BINARY LIMIT ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![key(after), limit as u32])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            check()?;
            let stored_key: Option<String> = row.get(0)?;
            let raw: Option<String> = row.get(1)?;
            let token: Option<String> = row.get(2)?;
            let has_token: bool = row.get(3)?;
            if has_token && token.is_none() {
                return Err(AppError::validation("forward.invalid"));
            }
            let raw = raw.ok_or_else(|| AppError::validation("forward.invalid"))?;
            let rule: ForwardRule = serde_json::from_str(&raw)?;
            super::contract::validate(&rule)?;
            if stored_key.as_deref() != Some(key(&rule.id).as_str()) {
                return Err(AppError::validation("forward.invalid"));
            }
            result.push(RevisionedRule {
                rule,
                revision: revision(&raw, token)?,
            });
        }
        Ok(result)
    })
}

pub(super) fn save(
    db: &Database,
    rule: &ForwardRule,
    expected: Option<&str>,
) -> AppResult<RevisionedRule> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        check(&tx, &rule.id, expected)?;
        crate::db::hosts::find_host(&tx, &rule.host_id)?;
        let revision = uuid::Uuid::new_v4().to_string();
        let updated = crate::models::now_ms();
        for (key, value) in [
            (key(&rule.id), serde_json::to_string(rule)?),
            (version_key(&rule.id), serde_json::to_string(&revision)?),
        ] {
            tx.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![key, value, updated])?;
        }
        tx.commit()?;
        Ok(RevisionedRule { rule: rule.clone(), revision })
    })
}
pub(super) fn remove(db: &Database, id: &str, expected: Option<&str>) -> AppResult<bool> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        check(&tx, id, expected)?;
        let removed = tx.execute("DELETE FROM settings WHERE key=?1", [key(id)])? != 0;
        tx.execute("DELETE FROM settings WHERE key=?1", [version_key(id)])?;
        tx.commit()?;
        Ok(removed)
    })
}
