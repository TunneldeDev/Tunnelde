use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecovery {
    pub backup: String,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableTransfer {
    pub id: String,
    pub direction: String,
    pub name: String,
    pub from_session: Option<String>,
    pub from_host_id: Option<String>,
    #[serde(default)]
    pub from_address: Option<String>,
    pub from_path: String,
    pub to_session: Option<String>,
    pub to_host_id: Option<String>,
    #[serde(default)]
    pub to_address: Option<String>,
    pub to_path: String,
    pub remove_source: bool,
    #[serde(default)]
    pub deleting_source: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_digest: Option<String>,
    pub overwrite: bool,
    pub transferred: u64,
    pub total: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_recovery: Option<BackupRecovery>,
    pub updated_at: i64,
}
pub struct Journal;

pub(super) fn record_cleanup_failure(row: &mut DurableTransfer, error: Option<AppError>) {
    row.error = Some(match error {
        Some(AppError::BackupRecovery {
            backup,
            destination,
        }) => {
            row.backup_recovery = Some(BackupRecovery {
                backup,
                destination,
            });
            "sftp.backupRecoveryRequired".into()
        }
        Some(AppError::BackupUnrecognized {
            backup,
            destination,
        }) => {
            row.backup_recovery = Some(BackupRecovery {
                backup,
                destination,
            });
            "sftp.backupUnrecognized".into()
        }
        Some(error) => error.to_string(),
        None => "sftp.transferTimedOut".into(),
    });
}

fn recovered_status(status: &str, active: bool) -> &str {
    match (status, active) {
        ("cancelling", true) => "running",
        ("cancelling", false) => "cancelled",
        ("running", false) => "paused",
        _ => status,
    }
}
impl Journal {
    pub fn upsert(app: &AppHandle, row: DurableTransfer) -> AppResult<()> {
        app.state::<AppState>().db.with(|conn| {conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![format!("transfer:{}",row.id),serde_json::to_string(&row)?,row.updated_at])?; Ok(())})
    }
    pub fn list(app: &AppHandle) -> AppResult<Vec<DurableTransfer>> {
        app.state::<AppState>().db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT value FROM settings WHERE key LIKE 'transfer:%' ORDER BY updated_at",
            )?;
            let values = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for value in values {
                out.push(serde_json::from_str(&value?)?);
            }
            Ok(out)
        })
    }
    pub fn get(app: &AppHandle, id: &str) -> AppResult<DurableTransfer> {
        app.state::<AppState>().db.with(|conn| {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM settings WHERE key=?1",
                    [format!("transfer:{id}")],
                    |r| r.get(0),
                )
                .optional()?;
            let raw = raw.ok_or_else(|| AppError::NotFound("sftp.transferNotFound".into()))?;
            Ok(serde_json::from_str(&raw)?)
        })
    }
    pub fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
        app.state::<AppState>().db.with(|conn| {
            conn.execute(
                "DELETE FROM settings WHERE key=?1 OR instr(key,?2)=1 OR instr(key,?3)=1 OR instr(key,?4)=1 OR instr(key,?5)=1 OR instr(key,?6)=1",
                rusqlite::params![
                    format!("transfer:{id}"),
                    format!("transfer-file:{id}:"),
                    format!("transfer-backup:{id}:"),
                    format!("transfer-part:{id}:"),
                    format!("transfer-artifact:{id}:"),
                    format!("transfer-parallel:{id}:")
                ],
            )?;
            Ok(())
        })?;
        let _ = app.emit("sftp://changed", ());
        Ok(())
    }

    fn clear_checkpoints(app: &AppHandle, id: &str) -> AppResult<()> {
        app.state::<AppState>().db.with(|conn| {
            for prefix in [
                "transfer-file",
                "transfer-backup",
                "transfer-part",
                "transfer-artifact",
                "transfer-parallel",
            ] {
                conn.execute(
                    "DELETE FROM settings WHERE instr(key,?1)=1",
                    [format!("{prefix}:{id}:")],
                )?;
            }
            Ok(())
        })
    }
}

/// Caller keeps the transfer reserved until cleanup and journal changes finish.
pub(super) async fn cleanup_artifacts(app: &AppHandle, row: &DurableTransfer) -> AppResult<()> {
    let has_artifacts = app.state::<AppState>().db.with(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE instr(key,?1)=1 OR instr(key,?2)=1)",
            rusqlite::params![
                format!("transfer-artifact:{}:", row.id),
                format!("transfer-file:{}:", row.id)
            ],
            |r| r.get::<_, bool>(0),
        )?)
    })?;
    if !has_artifacts {
        return Ok(());
    }
    let to = super::Endpoint {
        session: resolve_session(
            app,
            row.to_host_id.as_deref(),
            row.to_session.as_deref(),
            row.to_address.as_deref(),
        )?,
        path: row.to_path.clone(),
    };
    super::artifacts::cleanup(app, row, &to).await?;
    Journal::clear_checkpoints(app, &row.id)?;
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"files","sessionId":to.session}),
    );
    Ok(())
}
#[tauri::command]
pub fn durable_transfer_list(app: AppHandle) -> AppResult<Vec<DurableTransfer>> {
    let mut rows = Journal::list(&app)?;
    for row in &mut rows {
        let active = app.state::<AppState>().transfers.is_active(&row.id);
        if row.status == "running" && !active {
            row.error = Some("sftp.restartRecovery".into());
        }
        row.status = recovered_status(&row.status, active).into();
        row.phase = app
            .state::<AppState>()
            .transfers
            .inner
            .lock()
            .ok()
            .and_then(|state| state.active.get(&row.id).and_then(|task| task.event.phase))
            .map(str::to_owned);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_transfer_records_do_not_require_backup_recovery_details() {
        let row: DurableTransfer = serde_json::from_value(serde_json::json!({
            "id": "job", "direction": "transfer", "name": "file",
            "fromSession": null, "fromHostId": null, "fromPath": "/source",
            "toSession": null, "toHostId": null, "toPath": "/destination",
            "removeSource": false, "overwrite": false, "transferred": 0,
            "total": 0, "status": "cleanupPending", "error": null, "updatedAt": 1
        }))
        .unwrap();
        assert!(row.backup_recovery.is_none());
        assert!(row.move_digest.is_none());
        assert!(!row.deleting_source);
    }

    #[test]
    fn cleanup_retry_retains_last_known_backup_until_a_new_location_is_found() {
        let mut row: DurableTransfer = serde_json::from_value(serde_json::json!({
            "id": "job", "direction": "transfer", "name": "file",
            "fromSession": null, "fromHostId": null, "fromPath": "/source",
            "toSession": null, "toHostId": null, "toPath": "/destination",
            "removeSource": false, "overwrite": false, "transferred": 0,
            "total": 0, "status": "cleanupPending", "error": null, "updatedAt": 1
        }))
        .unwrap();
        record_cleanup_failure(
            &mut row,
            Some(AppError::BackupRecovery {
                backup: "/old-backup".into(),
                destination: "/old-target".into(),
            }),
        );
        record_cleanup_failure(
            &mut row,
            Some(AppError::validation("sftp.reconnectRequired")),
        );
        assert_eq!(row.error.as_deref(), Some("sftp.reconnectRequired"));
        assert_eq!(row.backup_recovery.as_ref().unwrap().backup, "/old-backup");
        record_cleanup_failure(&mut row, None);
        assert_eq!(row.error.as_deref(), Some("sftp.transferTimedOut"));
        assert_eq!(row.backup_recovery.as_ref().unwrap().backup, "/old-backup");
        record_cleanup_failure(
            &mut row,
            Some(AppError::BackupRecovery {
                backup: "/new-backup".into(),
                destination: "/new-target".into(),
            }),
        );
        assert_eq!(
            row.backup_recovery.as_ref().unwrap().destination,
            "/new-target"
        );
        record_cleanup_failure(
            &mut row,
            Some(AppError::BackupUnrecognized {
                backup: "/unrecognized".into(),
                destination: "/target".into(),
            }),
        );
        assert_eq!(row.error.as_deref(), Some("sftp.backupUnrecognized"));
        assert_eq!(
            row.backup_recovery.as_ref().unwrap().backup,
            "/unrecognized"
        );
    }

    #[test]
    fn interrupted_cancellation_never_becomes_resumable_after_restart() {
        assert_eq!(recovered_status("running", false), "paused");
        assert_eq!(recovered_status("cancelling", false), "cancelled");
        assert_eq!(recovered_status("cancelling", true), "running");
        assert_eq!(recovered_status("cancelled", false), "cancelled");
        assert_eq!(recovered_status("paused", false), "paused");
        assert_eq!(recovered_status("done", false), "done");
        assert_eq!(recovered_status("cleanupPending", false), "cleanupPending");
    }

    fn connection(
        id: &str,
        host: &str,
        address: &str,
        connected_at: i64,
    ) -> crate::ssh::SessionInfo {
        crate::ssh::SessionInfo {
            id: id.into(),
            host_id: host.into(),
            address: address.into(),
            title: host.into(),
            cols: 80,
            rows: 24,
            connected_at,
            terminal: true,
            purpose: None,
        }
    }

    #[test]
    fn reconnect_chooses_newest_matching_endpoint_not_hashmap_order() {
        let old = connection("old", "host", "user@server:22", 1);
        let new = connection("new", "host", "user@server:22", 2);
        let changed = connection("changed", "host", "other@different:22", 3);
        for sessions in [
            vec![old.clone(), new.clone(), changed.clone()],
            vec![changed, new, old],
        ] {
            assert_eq!(
                select_session(&sessions, Some("host"), Some("old"), Some("user@server:22"))
                    .unwrap(),
                Some("new".into())
            );
        }
    }

    #[test]
    fn disconnected_remote_never_falls_back_to_local_or_another_machine() {
        let sessions = vec![connection("other", "host", "user@different:22", 3)];
        assert!(
            select_session(&sessions, Some("host"), Some("old"), Some("user@server:22")).is_err()
        );
        assert!(select_session(&sessions, Some("missing"), None, None).is_err());
        assert!(select_session(&sessions, None, Some("old"), None).is_err());
        assert_eq!(select_session(&sessions, None, None, None).unwrap(), None);
    }
}
#[tauri::command]
pub async fn durable_transfer_clear(
    app: AppHandle,
    id: String,
) -> AppResult<Option<DurableTransfer>> {
    // Reserve the same registry entry as resume so cleanup and writing cannot race.
    app.state::<AppState>().transfers.register(
        &id,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        None,
    )?;
    let result = async {
        let mut row = Journal::get(&app, &id)?;
        if row.status == "done" {
            Journal::remove(&app, &id)?;
            return Ok(None);
        }
        // Persist intent before touching the socket: restart/reconnect must not
        // turn a discarded job into a resumable one or lose its owned artifacts.
        row.status = "cleanupPending".into();
        row.updated_at = crate::models::now_ms();
        Journal::upsert(&app, row.clone())?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            cleanup_artifacts(&app, &row),
        )
        .await;
        match result {
            Ok(Ok(())) => {
                Journal::remove(&app, &id)?;
                Ok(None)
            }
            failed => {
                record_cleanup_failure(&mut row, failed.ok().and_then(Result::err));
                row.updated_at = crate::models::now_ms();
                Journal::upsert(&app, row.clone())?;
                let _ = app.emit("sftp://changed", ());
                Ok(Some(row))
            }
        }
    }
    .await;
    app.state::<AppState>().transfers.release(&id);
    result
}
#[tauri::command]
pub fn durable_transfer_pause(app: AppHandle, id: String) -> AppResult<()> {
    let _ = Journal::get(&app, &id)?;
    app.state::<AppState>().transfers.pause(&id);
    Ok(())
}
#[tauri::command]
pub fn durable_transfer_resume(app: AppHandle, id: String) -> AppResult<()> {
    let row = Journal::get(&app, &id)?;
    let from = super::Endpoint {
        session: resolve_session(
            &app,
            row.from_host_id.as_deref(),
            row.from_session.as_deref(),
            row.from_address.as_deref(),
        )?,
        path: row.from_path.clone(),
    };
    let to = super::Endpoint {
        session: resolve_session(
            &app,
            row.to_host_id.as_deref(),
            row.to_session.as_deref(),
            row.to_address.as_deref(),
        )?,
        path: row.to_path.clone(),
    };
    super::resume_transfer(app, from, to, row)
}

fn resolve_session(
    app: &AppHandle,
    host: Option<&str>,
    old: Option<&str>,
    address: Option<&str>,
) -> AppResult<Option<String>> {
    let sessions = app.state::<AppState>().ssh.list();
    select_session(&sessions, host, old, address)
}

fn select_session(
    sessions: &[crate::ssh::SessionInfo],
    host: Option<&str>,
    old: Option<&str>,
    address: Option<&str>,
) -> AppResult<Option<String>> {
    match host {
        Some(host) => sessions
            .iter()
            .filter(|s| {
                s.purpose.as_deref() != Some("forwarding")
                    && s.host_id == host
                    && address.is_none_or(|address| s.address == address)
            })
            .max_by_key(|s| (s.connected_at, s.id.as_str()))
            .map(|s| Some(s.id.clone()))
            .ok_or_else(|| AppError::validation("sftp.reconnectRequired")),
        None => {
            if old.is_some() {
                Err(AppError::validation("sftp.reconnectRequired"))
            } else {
                Ok(None)
            }
        }
    }
}

/// Retry only explicit disposal requests, never restart a user's file transfer.
/// Registry reservation serializes concurrent reconnects and manual retries.
pub(crate) async fn on_reconnect(app: &AppHandle) {
    let Ok(rows) = Journal::list(app) else { return };
    for row in rows {
        if row.status == "cleanupPending"
            && resolve_session(
                app,
                row.to_host_id.as_deref(),
                row.to_session.as_deref(),
                row.to_address.as_deref(),
            )
            .is_ok()
        {
            if let Err(error) = durable_transfer_clear(app.clone(), row.id).await {
                tracing::debug!(%error, "Deferred transfer cleanup remains pending");
            }
        }
    }
}
