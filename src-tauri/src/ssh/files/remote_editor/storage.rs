//! SQLite recovery checkpoints are durable before a mutation can be submitted.
use super::*;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

fn synced<T>(
    conn: &Connection,
    action: impl FnOnce(&Transaction<'_>) -> AppResult<T>,
) -> AppResult<T> {
    if !conn.is_autocommit() {
        return Err(AppError::validation("editor.cleanupBusy"));
    }
    let previous: i64 = conn.pragma_query_value(None, "synchronous", |row| row.get(0))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let result = (|| {
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        let result = action(&tx)?;
        tx.commit()?;
        Ok(result)
    })();
    let restored = conn.pragma_update(None, "synchronous", previous);
    result.and_then(|value| restored.map(|_| value).map_err(Into::into))
}

pub(super) fn load(conn: &Connection, id: &str) -> AppResult<Option<Record>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("{PREFIX}{id}")],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        let record: Record = serde_json::from_str(&raw)?;
        if record.id != id {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        if let Some(receipt) = &record.receipt {
            receipt.validate()?;
        }
        Ok(record)
    })
    .transpose()
}

fn same_owner(a: &Record, b: &Record) -> bool {
    a.id == b.id
        && a.token == b.token
        && a.host_id == b.host_id
        && a.address == b.address
        && a.directory == b.directory
        && a.path == b.path
}

pub(super) fn persist(conn: &Connection, record: &Record) -> AppResult<()> {
    synced(conn, |tx| {
        let current =
            load(tx, &record.id)?.ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
        if !same_owner(&current, record) {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        let same_generation = match (&current.receipt, &record.receipt) {
            (Some(previous), Some(next)) => next.follows(previous),
            (None, None) => true,
            _ => false,
        };
        if !same_generation || (current.removing_marker && !record.removing_marker) {
            return Err(AppError::validation("editor.cleanupBusy"));
        }
        tx.execute(
            "UPDATE settings SET value=?2,updated_at=?3 WHERE key=?1",
            rusqlite::params![
                format!("{PREFIX}{}", record.id),
                serde_json::to_string(record)?,
                crate::models::now_ms()
            ],
        )?;
        Ok(())
    })
}

pub(super) fn create(conn: &Connection, record: &Record) -> AppResult<()> {
    if !record
        .receipt
        .as_ref()
        .is_some_and(recovery::Receipt::is_unsent)
        || record.removing_marker
    {
        return Err(AppError::validation("editor.cleanupUnrecognized"));
    }
    synced(conn, |tx| {
        let total: i64 = tx.query_row(
            "SELECT count(*) FROM settings WHERE instr(key,?1)=1",
            [PREFIX],
            |row| row.get(0),
        )?;
        if total >= 128 {
            return Err(AppError::validation("editor.remoteRecoveryLimit"));
        }
        tx.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)",
            rusqlite::params![
                format!("{PREFIX}{}", record.id),
                serde_json::to_string(record)?,
                crate::models::now_ms()
            ],
        )?;
        Ok(())
    })
}
pub(super) fn forget(conn: &Connection, record: &Record) -> AppResult<()> {
    recovery::require_settled(record)?;
    synced(conn, |tx| {
        let current =
            load(tx, &record.id)?.ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
        if serde_json::to_value(&current)? != serde_json::to_value(record)? {
            return Err(AppError::validation("editor.cleanupBusy"));
        }
        tx.execute(
            "DELETE FROM settings WHERE key=?1",
            [format!("{PREFIX}{}", record.id)],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests;
