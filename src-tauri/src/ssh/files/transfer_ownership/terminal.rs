//! Finish under the original owner, then sync the projection before retirement.
mod projection;
use super::*;
use native_save::runtime::{TransferOutcome, TransferTerminal};
pub(in crate::ssh::files) use projection::project;

pub(in crate::ssh::files) async fn finish(
    app: &AppHandle,
    id: &str,
    outcome: TransferOutcome,
) -> AppResult<bool> {
    let state = app.state::<AppState>();
    let ownership = state.transfers.ownership(id)?;
    let terminal = {
        let mut current = ownership.lock().await;
        match current.as_mut() {
            Some(attempt) => {
                let terminal = attempt.complete(outcome).await?;
                *current = None;
                Some(terminal)
            }
            None => state
                .native_saves
                .transfer_terminals()
                .await?
                .into_iter()
                .find(|terminal| terminal.task().id == id),
        }
    };
    let Some(terminal) = terminal else {
        return Ok(false);
    };
    persist(app, &terminal).await?;
    Ok(true)
}

pub(in crate::ssh::files) async fn dispose_empty(app: &AppHandle, id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.db.with(|conn| {
        super::super::artifacts::retained::protect_remove(conn, id)?;
        for prefix in [
            "transfer-file",
            "transfer-backup",
            "transfer-part",
            "transfer-artifact",
            "transfer-parallel",
            "transfer-directory-move",
        ] {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM settings WHERE instr(key,?1)=1)",
                [format!("{prefix}:{id}:")],
                |row| row.get(0),
            )?;
            if present {
                return Err(AppError::validation("editor.remoteOutcomeUnknown"));
            }
        }
        Ok(())
    })?;
    state.transfers.park_ownership(id).await?;
    if let Some(terminal) = state.native_saves.dispose_empty_task(id).await? {
        persist(app, &terminal).await?;
    }
    Ok(())
}

async fn persist(app: &AppHandle, terminal: &TransferTerminal) -> AppResult<()> {
    let state = app.state::<AppState>();
    state
        .native_saves
        .project_transfer_terminal(terminal, |terminal| {
            state.db.with(|conn| project(conn, terminal))
        })
        .await?;
    let _ = app.emit("sftp://changed", ());
    let _ = app.emit("editor://cleanup-changed", ());
    Ok(())
}

/// Recovery performs local projection only: no remote probes or task replay.
pub(in crate::ssh::files) async fn reconcile(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    for terminal in state.native_saves.transfer_terminals().await? {
        // Same registry reservation as writers/cleanup; a concurrent finish or
        // resume cannot race the projection acknowledgement and retirement.
        let Ok(_reservation) = state.transfers.reserve_cleanup(&terminal.task().id) else {
            continue;
        };
        persist(app, &terminal).await?;
    }
    Ok(())
}
