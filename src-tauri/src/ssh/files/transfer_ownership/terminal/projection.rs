//! Rebuild only from authoritative terminal intent; never adopt mutable app paths.
use super::*;
use native_save::runtime::{TaskEndpoint, TransferTask};
use rusqlite::OptionalExtension;

pub(in crate::ssh::files) fn project(
    conn: &rusqlite::Connection,
    terminal: &TransferTerminal,
) -> AppResult<()> {
    let task = terminal.task();
    checkpoint::synced(conn, || {
        let tx = conn.unchecked_transaction()?;
        let key = format!("transfer:{}", task.id);
        let previous: Option<String> = tx
            .query_row("SELECT value FROM settings WHERE key=?1", [&key], |row| {
                row.get(0)
            })
            .optional()?;
        let mut row = match previous {
            Some(previous) => serde_json::from_str::<durable::DurableTransfer>(&previous)?,
            None => restored(task),
        };
        if !preparation::matches_row(&row, task) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        checkpoint::write_link(&tx, &task.id, &terminal.reference()?)?;
        row.status = match terminal.outcome() {
            TransferOutcome::Completed { transferred, total } => {
                row.transferred = *transferred;
                row.total = *total;
                "done"
            }
            TransferOutcome::Disposed => "cancelled",
        }
        .into();
        row.phase = None;
        row.error = None;
        row.backup_recovery = None;
        row.artifact_recovery = None;
        row.updated_at = crate::models::now_ms();
        tx.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![key,serde_json::to_string(&row)?,row.updated_at])?;
        // All remote cleanup has already been observed by the original sealed
        // worker. Forget local checkpoints atomically with its terminal row.
        for prefix in [
            "transfer-file",
            "transfer-backup",
            "transfer-part",
            "transfer-artifact",
            "transfer-parallel",
            "transfer-directory-move",
        ] {
            tx.execute(
                "DELETE FROM settings WHERE instr(key,?1)=1",
                [format!("{prefix}:{}:", task.id)],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

fn host(endpoint: &TaskEndpoint) -> Option<String> {
    endpoint
        .remote
        .as_ref()
        .map(|remote| remote.host_id.clone())
}
fn address(endpoint: &TaskEndpoint) -> Option<String> {
    endpoint
        .remote
        .as_ref()
        .map(|remote| remote.address.clone())
}
fn restored(task: &TransferTask) -> durable::DurableTransfer {
    durable::DurableTransfer {
        id: task.id.clone(),
        plugin_id: task.plugin_id.clone(),
        retained_creation: false,
        retained_settlement: None,
        direction: "transfer".into(),
        name: file_name_of(&task.source.path),
        from_session: None,
        from_host_id: host(&task.source),
        from_address: address(&task.source),
        from_path: task.source.path.clone(),
        to_session: None,
        to_host_id: host(&task.destination),
        to_address: address(&task.destination),
        to_path: task.destination.path.clone(),
        remove_source: task.remove_source,
        deleting_source: false,
        move_recovery: None,
        directory_move_manifest: None,
        overwrite: task.overwrite,
        transferred: 0,
        total: 0,
        speed_limit_kib: 0,
        status: "running".into(),
        phase: None,
        error: None,
        backup_recovery: None,
        artifact_recovery: None,
        updated_at: crate::models::now_ms(),
    }
}
