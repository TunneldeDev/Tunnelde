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

/// Proof saved before a guarded local move may remove its source. File identity
/// rejects replacements even when their contents match the original exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRecovery {
    pub source: crate::platform::file_identity::FileIdentity,
    pub destination: crate::platform::file_identity::FileIdentity,
    pub length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableTransfer {
    pub id: String,
    /// Attribution only, never an authorization to resume a former runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
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
    pub move_recovery: Option<MoveRecovery>,
    pub overwrite: bool,
    pub transferred: u64,
    pub total: u64,
    #[serde(default)]
    pub speed_limit_kib: u32,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_recovery: Option<BackupRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_recovery: Option<String>,
    pub updated_at: i64,
}

impl DurableTransfer {
    pub(super) fn require_user_control(&self) -> AppResult<()> {
        if self.plugin_id.is_some() {
            return Err(AppError::validation("sftp.pluginTransferNotResumable"));
        }
        Ok(())
    }

    fn retire_plugin_runtime(&mut self, active: bool) -> bool {
        if self.plugin_id.is_some()
            && !active
            && matches!(self.status.as_str(), "running" | "paused" | "cancelling")
        {
            self.status = "cleanupPending".into();
            self.error = Some("sftp.pluginTransferInterrupted".into());
            self.updated_at = crate::models::now_ms();
            return true;
        }
        false
    }
}
pub struct Journal;

// Progress/completion writers may hold a snapshot from before a live limit
// change. Preserve the current setting atomically instead of restoring that
// stale snapshot's limit.
const UPSERT_TRANSFER: &str = "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=json_set(excluded.value,'$.speedLimitKib',coalesce(json_extract(settings.value,'$.speedLimitKib'),0)),updated_at=excluded.updated_at";
const SET_SPEED_LIMIT: &str = "UPDATE settings SET value=json_set(value,'$.speedLimitKib',?1,'$.updatedAt',?2),updated_at=?2 WHERE key=?3";

fn write_row(conn: &rusqlite::Connection, row: &DurableTransfer) -> AppResult<()> {
    conn.execute(
        UPSERT_TRANSFER,
        rusqlite::params![
            format!("transfer:{}", row.id),
            serde_json::to_string(row)?,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn write_move_intent(conn: &rusqlite::Connection, row: &DurableTransfer) -> AppResult<()> {
    if !conn.is_autocommit() || !row.deleting_source || row.move_recovery.is_none() {
        return Err(AppError::internal("Invalid move deletion checkpoint"));
    }
    // Progress uses NORMAL for performance. This single destructive boundary
    // requires a synced WAL commit while the application's DB mutex is held.
    let previous: i64 = conn.pragma_query_value(None, "synchronous", |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let written = write_row(conn, row);
    let restored = conn.pragma_update(None, "synchronous", previous);
    written?;
    restored?;
    Ok(())
}

pub(super) fn needs_review(error: Option<&str>) -> bool {
    matches!(
        error,
        Some(
            "sftp.moveRecoverySourcePresent"
                | "sftp.moveRecoveryUnverified"
                | "sftp.moveSourceRetained"
                | "sftp.backupPreserved"
                | "sftp.transferArtifactUnrecognized"
        )
    )
}

pub(super) fn record_cleanup_failure(row: &mut DurableTransfer, error: Option<AppError>) {
    row.error = Some(match error {
        Some(AppError::TransferArtifactUnrecognized { path }) => {
            row.artifact_recovery = Some(path);
            "sftp.transferArtifactUnrecognized".into()
        }
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
        Some(AppError::BackupPreserved {
            backup,
            destination,
        }) => {
            row.backup_recovery = Some(BackupRecovery {
                backup,
                destination,
            });
            "sftp.backupPreserved".into()
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
        app.state::<AppState>()
            .db
            .with(|conn| write_row(conn, &row))
    }

    pub(super) fn commit_move_intent(app: &AppHandle, row: DurableTransfer) -> AppResult<()> {
        app.state::<AppState>()
            .db
            .with(|conn| write_move_intent(conn, &row))
    }

    pub(super) fn set_speed_limit(app: &AppHandle, id: &str, kib: u32) -> AppResult<()> {
        app.state::<AppState>().db.with(|conn| {
            conn.execute(
                SET_SPEED_LIMIT,
                rusqlite::params![kib, crate::models::now_ms(), format!("transfer:{id}")],
            )?;
            Ok(())
        })
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
        row.retire_plugin_runtime(active);
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
    fn review_outcomes_cannot_be_retried_as_transfers() {
        for error in [
            "sftp.moveSourceRetained",
            "sftp.backupPreserved",
            "sftp.moveRecoverySourcePresent",
            "sftp.moveRecoveryUnverified",
            "sftp.transferArtifactUnrecognized",
        ] {
            assert!(needs_review(Some(error)));
        }
        assert!(!needs_review(None));
        assert!(!needs_review(Some("sftp.transferTimedOut")));
        assert!(!needs_review(Some("sftp.resumePrefixMismatch")));
    }

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
        assert!(row.artifact_recovery.is_none());
        assert!(row.move_recovery.is_none());
        assert_eq!(row.speed_limit_kib, 0);
    }

    fn move_intent() -> DurableTransfer {
        serde_json::from_value(serde_json::json!({
            "id": "job", "direction": "transfer", "name": "file",
            "fromSession": null, "fromHostId": null, "fromPath": "C:\\source",
            "toSession": null, "toHostId": null, "toPath": "D:\\destination",
            "removeSource": true, "deletingSource": true,
            "moveRecovery": {
                "source": { "platform": "windows", "volume": u64::MAX - 2, "index": vec![1; 16], "created": 134385039605809181u64 },
                "destination": { "platform": "windows", "volume": 2, "index": vec![2; 16], "created": 20 },
                "length": 3, "sha256": "abc"
            },
            "overwrite": false, "transferred": 3,
            "total": 3, "status": "running", "error": null, "updatedAt": 1
        }))
        .unwrap()
    }

    #[test]
    fn old_user_journals_remain_resumable_but_plugin_journals_never_grant_execution() {
        let mut row = move_intent();
        assert!(row.plugin_id.is_none());
        assert!(row.require_user_control().is_ok());
        row.plugin_id = Some("formatter".into());
        let restored: DurableTransfer =
            serde_json::from_str(&serde_json::to_string(&row).unwrap()).unwrap();
        assert_eq!(restored.plugin_id.as_deref(), Some("formatter"));
        for status in [
            "running",
            "paused",
            "failed",
            "cancelled",
            "done",
            "cleanupPending",
        ] {
            row.status = status.into();
            assert_eq!(
                row.require_user_control().unwrap_err().to_string(),
                "sftp.pluginTransferNotResumable"
            );
        }
    }

    #[test]
    fn interrupted_plugin_work_is_disposal_only_and_never_retires_live_or_completed_work() {
        for plugin in [false, true] {
            for active in [false, true] {
                for status in [
                    "running",
                    "paused",
                    "failed",
                    "cancelled",
                    "done",
                    "cleanupPending",
                    "cancelling",
                ] {
                    let mut row = move_intent();
                    row.plugin_id = plugin.then(|| "formatter".into());
                    row.status = status.into();
                    let retires =
                        plugin && !active && matches!(status, "running" | "paused" | "cancelling");
                    assert_eq!(row.retire_plugin_runtime(active), retires);
                    assert_eq!(row.status, if retires { "cleanupPending" } else { status });
                    if retires {
                        assert_eq!(row.error.as_deref(), Some("sftp.pluginTransferInterrupted"));
                        assert!(!row.retire_plugin_runtime(false));
                    }
                }
            }
        }
    }

    #[test]
    fn removal_checkpoint_uses_synced_commit_and_survives_database_reopen() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-move-journal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("journal.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
            CREATE TRIGGER require_synced_intent BEFORE INSERT ON settings WHEN (SELECT synchronous FROM pragma_synchronous) < 2 BEGIN SELECT RAISE(ABORT,'checkpoint is not durable'); END;").unwrap();
        let row = move_intent();
        assert!(write_row(&conn, &row).is_err());
        write_move_intent(&conn, &row).unwrap();
        // SQLite's JSON edits for live limits must preserve identifiers beyond
        // JavaScript's exact-integer range and even beyond SQLite's signed i64.
        conn.execute(SET_SPEED_LIMIT, rusqlite::params![128, 2, "transfer:job"])
            .unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(conn);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let raw: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='transfer:job'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let restored: DurableTransfer = serde_json::from_str(&raw).unwrap();
        assert!(restored.deleting_source);
        assert_eq!(restored.move_recovery, row.move_recovery);
        assert_eq!(restored.transferred, 3);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_removal_checkpoint_restores_normal_progress_sync_policy() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA synchronous=NORMAL; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TRIGGER reject_intent BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
        assert!(write_move_intent(&conn, &move_intent()).is_err());
        assert_eq!(
            conn.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let mut row = move_intent();
        row.move_recovery = None;
        assert!(write_move_intent(&conn, &row).is_err());
        let tx = conn.unchecked_transaction().unwrap();
        assert!(write_move_intent(&tx, &move_intent()).is_err());
    }

    #[test]
    fn cleanup_retries_preserve_unrecognized_artifact_paths_across_serialization() {
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
            Some(AppError::TransferArtifactUnrecognized {
                path: "C:\\downloads\\owned.part".into(),
            }),
        );
        assert!(needs_review(row.error.as_deref()));
        for error in [Some(AppError::validation("sftp.reconnectRequired")), None] {
            record_cleanup_failure(&mut row, error);
            row = serde_json::from_str(&serde_json::to_string(&row).unwrap()).unwrap();
            assert_eq!(
                row.artifact_recovery.as_deref(),
                Some("C:\\downloads\\owned.part")
            );
        }
    }

    #[test]
    fn durable_speed_limit_survives_stale_progress_and_completion_snapshots() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)").unwrap();
        let original = serde_json::json!({"transferred":0,"status":"running","updatedAt":1});
        conn.execute(
            UPSERT_TRANSFER,
            rusqlite::params!["transfer:job", original.to_string(), 1],
        )
        .unwrap();
        conn.execute(SET_SPEED_LIMIT, rusqlite::params![128, 2, "transfer:job"])
            .unwrap();
        let read = || -> serde_json::Value {
            let raw: String = conn
                .query_row(
                    "SELECT value FROM settings WHERE key='transfer:job'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            serde_json::from_str(&raw).unwrap()
        };
        for status in ["running", "paused", "failed", "done"] {
            let stale = serde_json::json!({"transferred":1024,"speedLimitKib":0,"status":status,"updatedAt":3});
            conn.execute(
                UPSERT_TRANSFER,
                rusqlite::params!["transfer:job", stale.to_string(), 3],
            )
            .unwrap();
            assert_eq!(read()["speedLimitKib"], 128);
            assert_eq!(read()["status"], status);
            assert_eq!(read()["transferred"], 1024);
        }
        conn.execute(SET_SPEED_LIMIT, rusqlite::params![0, 4, "transfer:job"])
            .unwrap();
        conn.execute(
            UPSERT_TRANSFER,
            rusqlite::params![
                "transfer:job",
                serde_json::json!({"speedLimitKib":128}).to_string(),
                5
            ],
        )
        .unwrap();
        assert_eq!(read()["speedLimitKib"], 0);
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
        record_cleanup_failure(
            &mut row,
            Some(AppError::BackupPreserved {
                backup: "/preserved".into(),
                destination: "/complete".into(),
            }),
        );
        assert_eq!(row.error.as_deref(), Some("sftp.backupPreserved"));
        assert_eq!(row.backup_recovery.as_ref().unwrap().backup, "/preserved");
        assert_eq!(
            row.backup_recovery.as_ref().unwrap().destination,
            "/complete"
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
    let state = app.state::<AppState>();
    let _reservation = state.transfers.reserve_cleanup(&id)?;
    async {
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
    .await
}
#[tauri::command]
pub fn durable_transfer_pause(app: AppHandle, id: String) -> AppResult<()> {
    Journal::get(&app, &id)?.require_user_control()?;
    app.state::<AppState>().transfers.pause(&id);
    Ok(())
}
#[tauri::command]
pub fn durable_transfer_resume(app: AppHandle, id: String) -> AppResult<()> {
    let row = Journal::get(&app, &id)?;
    row.require_user_control()?;
    if needs_review(row.error.as_deref()) {
        return Err(AppError::validation(row.error.unwrap_or_default()));
    }
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

pub(super) fn resolve_session(
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
        let row = if row.plugin_id.is_some() {
            // Re-read under the registry lock: an old running snapshot must not
            // retire a just-completed task. New tasks claim this lock before
            // publishing their journal; plugin tasks can never be resumed.
            let state = app.state::<AppState>();
            let Ok(registry) = state.transfers.inner.lock() else {
                continue;
            };
            let Ok(mut current) = Journal::get(app, &row.id) else {
                continue;
            };
            if current.retire_plugin_runtime(registry.active.contains_key(&row.id))
                && Journal::upsert(app, current.clone()).is_err()
            {
                continue;
            }
            current
        } else {
            row
        };
        if row.status == "cleanupPending"
            && resolve_session(
                app,
                row.to_host_id.as_deref(),
                row.to_session.as_deref(),
                row.to_address.as_deref(),
            )
            .is_ok()
        {
            // A reconnect can arrive while an older connection still owns a
            // bounded cleanup attempt. Retain that request until its registry
            // claim is released, then re-read both disposal intent and target.
            // Never clear an entry from a stale snapshot or spin on busy work.
            let retried = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    let state = app.state::<AppState>();
                    let released = state.transfers.released.notified();
                    tokio::pin!(released);
                    released.as_mut().enable();
                    let current = match Journal::get(app, &row.id) {
                        Ok(current) => current,
                        Err(AppError::NotFound(_)) => return Ok(()),
                        Err(error) => return Err(error),
                    };
                    if current.status != "cleanupPending" {
                        return Ok(());
                    }
                    match durable_transfer_clear(app.clone(), current.id).await {
                        Err(AppError::Validation(message)) if message == "sftp.transferBusy" => {
                            released.await;
                        }
                        result => return result.map(|_| ()),
                    }
                }
            })
            .await;
            match retried {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::debug!(%error, "Deferred transfer cleanup remains pending");
                }
                Err(_) => {
                    tracing::debug!(
                        transfer_id = row.id,
                        "Deferred transfer cleanup retry timed out"
                    );
                }
            }
        }
    }
}
