//! The receipt owns task identity and settlement. Cleanup may only add an error
//! for the same settlement; an older UI snapshot cannot downgrade authority.
use super::{super::*, contracts::*};
use rusqlite::{Connection, OptionalExtension};

fn identity(record: &Record, task: &durable::DurableTransfer) -> AppResult<()> {
    if !task.retained_creation
        || task.id != record.task_id
        || task.plugin_id != record.plugin_id
        || task.to_host_id.as_deref() != Some(&record.host_id)
        || task.to_address.as_deref() != Some(&record.address)
        || task.to_path != record.target
        || task.artifact_recovery.as_deref() != Some(&record.directory)
        || task.remove_source
        || task.deleting_source
        || task.move_recovery.is_some()
        || task.directory_move_manifest.is_some()
        || task.from_session.is_some()
        || task.from_host_id.is_some()
        || !task.from_path.is_empty()
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn write(
    conn: &Connection,
    record: &Record,
    update: Option<&durable::DurableTransfer>,
) -> AppResult<()> {
    let key = format!("transfer:{}", record.task_id);
    let existing: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [&key], |row| {
            row.get(0)
        })
        .optional()?;
    let prior = existing
        .as_deref()
        .map(serde_json::from_str::<durable::DurableTransfer>)
        .transpose()?;
    if let Some(prior) = &prior {
        identity(record, prior)?;
    }
    if let Some(update) = update {
        identity(record, update)?;
    }
    let mut task = record.task();
    let previous = update
        .filter(|previous| previous.retained_settlement == task.retained_settlement)
        .or_else(|| {
            prior
                .as_ref()
                .filter(|previous| previous.retained_settlement == task.retained_settlement)
        });
    if let Some(previous) = previous {
        task.error = previous.error.clone().or(task.error);
        task.updated_at = task.updated_at.max(previous.updated_at);
    }
    let raw = serde_json::to_string(&task)?;
    if existing.as_deref() != Some(&raw) {
        conn.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![key, raw, task.updated_at],
        )?;
    }
    Ok(())
}
