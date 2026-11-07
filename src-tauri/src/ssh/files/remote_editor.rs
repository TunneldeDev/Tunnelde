//! Bounded, optimistic editor saves. The original is never opened with TRUNCATE.
//! SFTP v3 cannot make the last comparison and rename a compare-and-swap.
use super::*;
use russh_sftp::protocol::FileAttributes;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, Weak};

#[cfg(test)]
mod tests;

const PREFIX: &str = "editor-cleanup:";
const EVENT: &str = "editor://cleanup-changed";
type SaveLocks = Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>;
static LOCKS: OnceLock<SaveLocks> = OnceLock::new();
// false = an ordinary save (hidden), true = visible cleanup in progress.
static ACTIVE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

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
    pub(super) updated_at: i64,
    pub(super) error: Option<String>,
    pub(super) running: bool,
}

struct Reservation(String);
impl Reservation {
    fn acquire(id: &str, retry: bool) -> AppResult<Self> {
        let mut active = ACTIVE.get_or_init(Default::default).lock().unwrap();
        if active.contains_key(id) {
            return Err(AppError::validation("editor.cleanupBusy"));
        }
        active.insert(id.into(), retry);
        Ok(Self(id.into()))
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        ACTIVE.get().unwrap().lock().unwrap().remove(&self.0);
    }
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
    let value = serde_json::to_string(record)?;
    app.state::<AppState>().db.with(|conn| {
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![format!("{PREFIX}{}", record.id), value, crate::models::now_ms()])?;
        Ok(())
    })
}

fn forget(app: &AppHandle, record: &Record) -> AppResult<()> {
    app.state::<AppState>().db.with(|conn| {
        conn.execute(
            "DELETE FROM settings WHERE key=?1",
            [format!("{PREFIX}{}", record.id)],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn editor_cleanup_list(app: AppHandle) -> AppResult<Vec<PendingCleanup>> {
    let active = ACTIVE.get_or_init(Default::default).lock().unwrap();
    let mut pending: Vec<_> = records(&app)?
        .into_iter()
        .filter(|r| active.get(&r.id) != Some(&false))
        .map(|r| PendingCleanup {
            running: active.get(&r.id) == Some(&true),
            source: "remote",
            id: r.id,
            path: r.path,
            directory: r.directory,
            address: r.address,
            updated_at: r.updated_at,
            error: r.error,
        })
        .collect();
    drop(active);
    pending.extend(local_editor::pending(&app)?);
    Ok(pending)
}

fn session_for(app: &AppHandle, record: &Record) -> AppResult<String> {
    durable::resolve_session(app, Some(&record.host_id), None, Some(&record.address))?
        .ok_or_else(|| AppError::validation("sftp.reconnectRequired"))
}

#[tauri::command]
pub async fn editor_cleanup_retry(app: AppHandle, id: String) -> AppResult<()> {
    if id.starts_with("local-") {
        return local_editor::retry(app, id).await;
    }
    let _reservation = Reservation::acquire(&id, true)?;
    let _ = app.emit(EVENT, ());
    let mut record = records(&app)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::NotFound("editor.cleanupMissing".into()))?;
    let result = async {
        let sftp = session(&app, &session_for(&app, &record)?).await?;
        let result = cleanup(&sftp, &mut record, |r| persist(&app, r)).await;
        let _ = sftp.close().await;
        result?;
        forget(&app, &record)
    }
    .await;
    if let Err(error) = &result {
        record.error = Some(error.to_string());
        record.updated_at = crate::models::now_ms();
        persist(&app, &record)?;
    }
    drop(_reservation);
    let _ = app.emit(EVENT, ());
    result
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
    app: &AppHandle,
    session_id: &str,
    sftp: &SftpSession,
    path: &str,
    content: &str,
    baseline: Option<&str>,
) -> AppResult<()> {
    let host = app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| AppError::validation("sftp.reconnectRequired"))?;
    let target = sftp.canonicalize(path).await.map_err(map_sftp)?;
    if !target.starts_with('/') || target.contains('\0') {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    // Different tabs and SSH sessions for the same host share a publication lock.
    let lock = lock_for(format!("{}\0{target}", host.address));
    let _guard = lock.lock().await;
    let original = read_remote_text(sftp, &target).await?;
    if original.content == content {
        return Ok(());
    }
    if baseline.is_some_and(|expected| expected != original.content) {
        return Err(AppError::validation("editor.remoteFileChanged"));
    }
    // Negotiate before creating any remote artifacts. No non-atomic fallback.
    let replacement = remote_commit::Replacement::connect(app, session_id).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let parent = target
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let mut record = Record {
        directory: format!("{parent}/.tunnelde-save-{id}"),
        id,
        host_id: host.host_id,
        address: host.address,
        path: target.clone(),
        token: uuid::Uuid::new_v4().to_string(),
        removing_marker: false,
        updated_at: crate::models::now_ms(),
        error: None,
    };
    let reservation = Reservation::acquire(&record.id, false)?;
    persist(app, &record)?;
    let result = staged_save(
        sftp,
        &replacement,
        path,
        &target,
        content,
        &original.content,
        &record,
    )
    .await;
    match cleanup(sftp, &mut record, |r| persist(app, r)).await {
        Ok(()) => forget(app, &record)?,
        Err(error) => {
            tracing::warn!(%error, path = %record.directory, "Remote editor staging cleanup deferred");
            record.error = Some(error.to_string());
            record.updated_at = crate::models::now_ms();
            persist(app, &record)?;
        }
    }
    drop(reservation);
    let _ = app.emit(EVENT, ());
    result
}

fn same_metadata(a: &FileAttributes, b: &FileAttributes) -> bool {
    a.size == b.size
        && a.mtime == b.mtime
        && a.permissions == b.permissions
        && a.uid == b.uid
        && a.gid == b.gid
}

async fn exclusive_write(sftp: &SftpSession, path: &str, content: &[u8]) -> AppResult<()> {
    let mut file = sftp
        .open_with_flags_and_attributes(
            path,
            OpenFlags::READ | OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(map_sftp)?;
    let result = async {
        file.write_all(content).await?;
        file.flush().await?;
        file.sync_all().await.map_err(map_sftp)
    }
    .await;
    let closed = file.close().await;
    result?;
    closed?;
    Ok(())
}

async fn staged_save(
    sftp: &SftpSession,
    replacement: &remote_commit::Replacement,
    requested: &str,
    target: &str,
    content: &str,
    baseline: &str,
    record: &Record,
) -> AppResult<()> {
    let metadata = sftp.symlink_metadata(target).await.map_err(map_sftp)?;
    if !metadata.is_regular() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
    // Respect file access rights even if the parent directory permits replacement.
    let probe = sftp
        .open_with_flags(target, OpenFlags::WRITE)
        .await
        .map_err(map_sftp)?;
    probe.close().await?;
    replacement
        .raw()
        .mkdir(
            &record.directory,
            FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
        .map_err(map_sftp)?;
    let private = sftp
        .symlink_metadata(&record.directory)
        .await
        .map_err(map_sftp)?;
    if !private.is_dir() || private.permissions.is_none_or(|mode| mode & 0o777 != 0o700) {
        return Err(AppError::validation("editor.privateStagingRequired"));
    }
    exclusive_write(
        sftp,
        &format!("{}/owner", record.directory),
        record.token.as_bytes(),
    )
    .await?;
    let staging = format!("{}/content", record.directory);
    exclusive_write(sftp, &staging, content.as_bytes()).await?;
    // Ownership must precede mode: chown may clear setuid/setgid bits.
    if let (Some(uid), Some(gid)) = (metadata.uid, metadata.gid) {
        sftp.set_metadata(
            &staging,
            FileAttributes {
                uid: Some(uid),
                gid: Some(gid),
                ..Default::default()
            },
        )
        .await
        .map_err(map_sftp)?;
    }
    let permissions = metadata
        .permissions
        .ok_or_else(|| AppError::validation("editor.metadataNotPreserved"))?;
    sftp.set_metadata(
        &staging,
        FileAttributes {
            permissions: Some(permissions & 0o7777),
            ..Default::default()
        },
    )
    .await
    .map_err(map_sftp)?;
    let staged = sftp.symlink_metadata(&staging).await.map_err(map_sftp)?;
    if !staged.is_regular()
        || staged.uid != metadata.uid
        || staged.gid != metadata.gid
        || staged.permissions.map(|mode| mode & 0o7777) != Some(permissions & 0o7777)
        || read_remote_text(sftp, &staging).await?.content != content
    {
        return Err(AppError::validation("editor.metadataNotPreserved"));
    }
    let current = read_remote_text(sftp, target).await?;
    let latest = sftp.symlink_metadata(target).await.map_err(map_sftp)?;
    if current.content != baseline
        || !same_metadata(&metadata, &latest)
        || sftp.canonicalize(requested).await.map_err(map_sftp)? != target
    {
        return Err(AppError::validation("editor.remoteFileChanged"));
    }
    replacement.replace(&staging, target).await
}

fn missing(error: &russh_sftp::client::error::Error) -> bool {
    matches!(error, russh_sftp::client::error::Error::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

async fn cleanup(
    sftp: &SftpSession,
    record: &mut Record,
    checkpoint: impl Fn(&Record) -> AppResult<()>,
) -> AppResult<()> {
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
            sftp.remove_file(format!("{}/content", record.directory))
                .await
                .map_err(map_sftp)?;
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
            sftp.remove_file(marker).await.map_err(map_sftp)?;
        }
        Err(error) if missing(&error) => {}
        Err(error) => return Err(map_sftp(error)),
    }
    sftp.remove_dir(&record.directory).await.map_err(map_sftp)
}
