//! The app DB keeps only a durable reference, never dispatch authority.
use super::*;
use rusqlite::OptionalExtension;

fn key(id: &str) -> String {
    format!("transfer-claim:{id}")
}

pub(in crate::ssh::files) fn exists(conn: &rusqlite::Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)",
        [key(id)],
        |row| row.get(0),
    )?)
}

pub(in crate::ssh::files) fn link(
    conn: &rusqlite::Connection,
    id: &str,
    reference: &TransferReference,
) -> AppResult<()> {
    if !conn.is_autocommit() || !reference.belongs_to_task(id) {
        return Err(AppError::validation("editor.nativeChanged"));
    }
    let previous: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [key(id)],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(previous) = previous {
        let previous: TransferReference = serde_json::from_str(&previous)?;
        if !previous.same_task(reference) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
    }
    let serialized = serde_json::to_string(reference)?;
    let synchronous: i64 = conn.pragma_query_value(None, "synchronous", |row| row.get(0))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let result = conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![key(id), serialized, crate::models::now_ms()]);
    let restored = conn.pragma_update(None, "synchronous", synchronous);
    result?;
    restored?;
    Ok(())
}
