//! Bounded, optimistic editor saves. The original is never opened with TRUNCATE.
//! SFTP v3 cannot make the last comparison and rename a compare-and-swap.
use super::*;
use crate::services::files::write;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, Weak};

mod journal;
mod lifetime;
mod ownership;
mod pending;
pub(crate) mod policy;
mod recovery;
mod retained;
mod saving;
mod staging;
mod storage;
use journal::Journal;
use lifetime::Reservation;
mod transaction;
use transaction::staged_save;

#[cfg(test)]
mod tests;

const PREFIX: &str = "editor-cleanup:";
const EVENT: &str = "editor://cleanup-changed";
type SaveLocks = Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>;
static LOCKS: OnceLock<SaveLocks> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    host_id: String,
    address: String,
    path: String,
    directory: String,
    token: String,
    #[serde(default)]
    receipt: Option<recovery::Receipt>,
    #[serde(default)]
    admission: Option<native_save::runtime::MutationReference>,
    #[serde(default)]
    removing_marker: bool,
    updated_at: i64,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCleanup {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) directory: String,
    pub(super) address: String,
    pub(super) source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) action: Option<&'static str>,
    pub(super) updated_at: i64,
    pub(super) error: Option<String>,
    pub(super) running: bool,
}

fn records(app: &AppHandle) -> AppResult<Vec<Record>> {
    app.state::<AppState>().db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT value FROM settings WHERE key LIKE 'editor-cleanup:%'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    })
}

fn persist(app: &AppHandle, record: &Record) -> AppResult<()> {
    app.state::<AppState>()
        .db
        .with(|conn| storage::persist(conn, record))
}

fn forget(app: &AppHandle, record: &Record) -> AppResult<()> {
    app.state::<AppState>()
        .db
        .with(|conn| storage::forget(conn, record))
}

#[tauri::command]
pub async fn editor_cleanup_list(app: AppHandle) -> AppResult<Vec<PendingCleanup>> {
    let native = app.state::<AppState>().native_saves.clone();
    // SQLite and filesystem reads stay off the async executor as well.
    let read = app.clone();
    let mut pending = tauri::async_runtime::spawn_blocking(move || pending::legacy(&read))
        .await
        .unwrap_or_else(|_| pending::worker_failed());
    pending.extend(native.pending().await);
    Ok(pending)
}

fn remote_pending(app: &AppHandle) -> AppResult<Vec<PendingCleanup>> {
    // Keep registration/retirement ordered with the journal snapshot. Reading
    // these separately could expose a new ordinary save as inactive cleanup.
    let active = lifetime::active();
    let pending: Vec<_> = records(app)?
        .into_iter()
        .filter(|r| {
            active
                .get(&r.id)
                .is_none_or(|visible| visible.load(Ordering::Acquire))
        })
        .map(|r| {
            let error = r
                .error
                .clone()
                .or_else(|| recovery::require_settled(&r).err().map(|e| e.to_string()));
            PendingCleanup {
                running: active.contains_key(&r.id),
                source: "remote",
                action: None,
                id: r.id,
                path: r.path,
                directory: r.directory,
                address: r.address,
                updated_at: r.updated_at,
                error,
            }
        })
        .collect();
    drop(active);
    Ok(pending)
}

fn session_for(app: &AppHandle, record: &Record) -> AppResult<String> {
    durable::resolve_session(app, Some(&record.host_id), None, Some(&record.address))?
        .ok_or_else(|| AppError::validation("sftp.reconnectRequired"))
}

#[tauri::command]
pub async fn editor_cleanup_retry(app: AppHandle, id: String) -> AppResult<()> {
    if pending::diagnostic_id(&id) {
        return tauri::async_runtime::spawn_blocking(move || pending::retry(&app, &id))
            .await
            .map_err(|_| AppError::internal("editor.nativeWorkerFailed"))?;
    }
    if id.starts_with("native-") {
        let native = app.state::<AppState>().native_saves.clone();
        return native.retry(&app, &id).await;
    }
    if id.starts_with("local-") {
        return local_editor::retry(app, id).await;
    }
    let record = records(&app)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::NotFound("editor.cleanupMissing".into()))?;
    let connection = app.clone();
    let target = record.clone();
    retained::retry_with(
        &write::REMOTE_BUDGET,
        record,
        move || async move {
            let session_id = session_for(&connection, &target)?;
            // Owned admission below verifies the exact original claim. A generic
            // writable check here would reject that claim before it can resume.
            session(&connection, &session_id).await
        },
        app,
    )
    .await
}

pub(crate) async fn on_reconnect(app: &AppHandle) {
    let Ok(pending) = records(app) else { return };
    for record in pending {
        if session_for(app, &record).is_ok() {
            if let Err(error) = editor_cleanup_retry(app.clone(), record.id).await {
                tracing::debug!(%error, "Remote editor cleanup remains pending");
            }
        }
    }
}

fn lock_for(key: String) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

pub(super) async fn save(
    app: AppHandle,
    session_id: String,
    path: String,
    content: String,
    baseline: Option<String>,
    policy: impl policy::Policy,
) -> AppResult<()> {
    let host = app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| AppError::validation("sftp.reconnectRequired"))?;
    let request_path = path.clone();
    let request = saving::Request {
        session_id: session_id.clone(),
        host_id: host.host_id,
        address: host.address,
        path,
        content,
        baseline,
    };
    let connection = app.clone();
    saving::save_with(
        &write::REMOTE_BUDGET,
        request,
        policy,
        move |_job| async move {
            let sftp = admission::open(&connection, &session_id, &[&request_path]).await?;
            Ok((sftp, async move {
                remote_commit::Replacement::connect(&connection, &session_id).await
            }))
        },
        app,
    )
    .await
}

fn missing(error: &russh_sftp::client::error::Error) -> bool {
    matches!(error, russh_sftp::client::error::Error::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

async fn cleanup(
    sftp: &SftpSession,
    record: &mut Record,
    checkpoint: impl Fn(&Record) -> AppResult<()>,
) -> AppResult<()> {
    // Legacy or interrupted mutations have no terminal server authority.
    // Do not even probe paths: absence cannot fence another live connection.
    if !recovery::require_settled(record)? {
        return Ok(());
    }
    let metadata = match sftp.symlink_metadata(&record.directory).await {
        Ok(metadata) => metadata,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(map_sftp(error)),
    };
    let unrecognized = || AppError::validation("editor.cleanupUnrecognized");
    if !metadata.is_dir()
        || metadata
            .permissions
            .is_none_or(|mode| mode & 0o777 != 0o700)
    {
        return Err(unrecognized());
    }
    // Never recursively delete a staging path, including after a restart.
    let entries: Vec<_> = sftp
        .read_dir(&record.directory)
        .await
        .map_err(map_sftp)?
        .filter(|entry| !matches!(entry.file_name().as_str(), "." | ".."))
        .collect();
    if record.removing_marker {
        if entries.iter().any(|entry| entry.file_name() != "owner") {
            return Err(unrecognized());
        }
    } else {
        if entries.iter().any(|entry| {
            !matches!(entry.file_name().as_str(), "owner" | "content")
                || !entry.file_type().is_file()
        }) {
            return Err(unrecognized());
        }
        let marker = format!("{}/owner", record.directory);
        if read_remote_text(sftp, &marker).await?.content != record.token {
            return Err(unrecognized());
        }
        if entries.iter().any(|entry| entry.file_name() == "content") {
            let content = format!("{}/content", record.directory);
            recovery::cleanup_mutation(record, &checkpoint, sftp.remove_file(content)).await?;
        }
        // Persist the empty-directory cleanup phase before removing its proof.
        record.removing_marker = true;
        checkpoint(record)?;
    }
    let marker = format!("{}/owner", record.directory);
    match sftp.symlink_metadata(&marker).await {
        Ok(metadata) => {
            if !metadata.is_regular()
                || read_remote_text(sftp, &marker).await?.content != record.token
            {
                return Err(unrecognized());
            }
            recovery::cleanup_mutation(record, &checkpoint, sftp.remove_file(marker)).await?;
        }
        Err(error) if missing(&error) => {}
        Err(error) => return Err(map_sftp(error)),
    }
    let directory = record.directory.clone();
    recovery::cleanup_mutation(record, &checkpoint, sftp.remove_dir(directory)).await
}
