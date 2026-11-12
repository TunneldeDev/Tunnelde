//! Local editor transactions, with only staging cleanup persisted across restarts.
use super::*;
use crate::platform::editor_file::{self as native, Identity};
use crate::services::files::write;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::{Mutex, OnceLock, Weak};

pub(crate) mod policy;
mod saving;
mod transaction;
pub use saving::save;
pub(crate) use saving::save_checked;
#[cfg(test)]
pub(super) use saving::save_without_app;
#[cfg(test)]
use saving::{save_async, save_sync, save_transaction, save_with_budget};

#[cfg(test)]
mod tests;
const PREFIX: &str = "editor-local-cleanup:";
const EVENT: &str = "editor://cleanup-changed";
type SaveLocks = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;
static LOCKS: OnceLock<SaveLocks> = OnceLock::new();
static ACTIVE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    path: PathBuf,
    directory: PathBuf,
    directory_identity: Option<Identity>,
    staging_identity: Option<Identity>,
    token: String,
    removing_marker: bool,
    updated_at: i64,
    error: Option<String>,
}

struct Reservation(String);
impl Reservation {
    fn new(id: &str, retry: bool) -> AppResult<Self> {
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
            conn.prepare("SELECT value FROM settings WHERE key LIKE 'editor-local-cleanup:%'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    })
}

fn persist(app: &AppHandle, record: &Record) -> AppResult<()> {
    let value = serde_json::to_string(record)?;
    app.state::<AppState>().db.with(|conn| {
        conn.pragma_update(None, "synchronous", "FULL")?;
        let result = conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![format!("{PREFIX}{}", record.id), value, crate::models::now_ms()]);
        let restored = conn.pragma_update(None, "synchronous", "NORMAL");
        result?; restored?; Ok(())
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

pub(super) fn pending(app: &AppHandle) -> AppResult<Vec<remote_editor::PendingCleanup>> {
    let active = ACTIVE.get_or_init(Default::default).lock().unwrap();
    Ok(records(app)?
        .into_iter()
        .filter(|record| active.get(&record.id) != Some(&false))
        .map(|r| remote_editor::PendingCleanup {
            running: active.get(&r.id) == Some(&true),
            id: r.id,
            path: display_path(&r.path),
            directory: display_path(&r.directory),
            address: String::new(),
            source: "local",
            action: None,
            updated_at: r.updated_at,
            error: r.error,
        })
        .collect())
}

pub(super) async fn retry(app: AppHandle, id: String) -> AppResult<()> {
    let held = Reservation::new(&id, true)?;
    write::BUDGET
        .blocking(move |_| {
            let _ = app.emit(EVENT, ());
            let result = (|| {
                let mut record = records(&app)?
                    .into_iter()
                    .find(|record| record.id == id)
                    .ok_or_else(|| AppError::NotFound("editor.cleanupMissing".into()))?;
                let result = cleanup(&mut record, |r| persist(&app, r));
                match &result {
                    Ok(()) => forget(&app, &record)?,
                    Err(error) => {
                        record.error = Some(error.to_string());
                        record.updated_at = crate::models::now_ms();
                        persist(&app, &record)?;
                    }
                }
                result
            })();
            drop(held);
            let _ = app.emit(EVENT, ());
            result
        })
        .await
}

pub(crate) async fn on_start(app: &AppHandle) {
    let Ok(pending) = records(app) else { return };
    for record in pending {
        if let Err(error) = retry(app.clone(), record.id).await {
            tracing::debug!(%error, "Local editor staging cleanup remains pending");
        }
    }
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.into(), Arc::downgrade(&lock));
    lock
}

fn cleanup(record: &mut Record, checkpoint: impl Fn(&Record) -> AppResult<()>) -> AppResult<()> {
    let unrecognized = || AppError::validation("editor.cleanupUnrecognized");
    let directory = match native::directory_identity(&record.directory) {
        Ok(identity) => identity,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if record.directory_identity.as_ref() != Some(&directory) {
        return Err(unrecognized());
    }
    let entries = std::fs::read_dir(&record.directory)?.collect::<std::io::Result<Vec<_>>>()?;
    if entries.is_empty() {
        std::fs::remove_dir(&record.directory)?;
        return Ok(());
    }
    for entry in &entries {
        let name = entry.file_name();
        if !matches!(name.to_str(), Some("owner" | "content"))
            || !entry.file_type()?.is_file()
            || (record.removing_marker && name != "owner")
        {
            return Err(unrecognized());
        }
    }
    let marker = record.directory.join("owner");
    if !record.removing_marker {
        let mut file = native::open_regular(&marker, false)?;
        if native::read_bounded(&mut file, 128)? != record.token.as_bytes() {
            return Err(unrecognized());
        }
        drop(file);
        let staging = record.directory.join("content");
        match native::open_regular(&staging, false) {
            Ok(file) => {
                if record.staging_identity.as_ref() != Some(&native::identity(&file)?) {
                    return Err(unrecognized());
                }
                drop(file);
                remove_verified(&staging, record.staging_identity.as_ref().unwrap())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        record.removing_marker = true;
        checkpoint(record)?;
    }
    match native::open_regular(&marker, false) {
        Ok(mut file) => {
            if native::read_bounded(&mut file, 128)? != record.token.as_bytes() {
                return Err(unrecognized());
            }
            let identity = native::identity(&file)?;
            drop(file);
            remove_verified(&marker, &identity)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if native::directory_identity(&record.directory)? != directory {
        return Err(unrecognized());
    }
    // Empty-directory-only removal cannot recursively delete unrelated contents.
    std::fs::remove_dir(&record.directory)?;
    Ok(())
}

fn remove_verified(path: &Path, expected: &Identity) -> AppResult<()> {
    #[cfg(windows)]
    {
        let held = crate::platform::guarded_file::GuardedFile::deletable(path)?;
        if (Identity::Windows {
            file: held.identity()?,
        }) != *expected
        {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        held.delete()?;
    }
    #[cfg(unix)]
    {
        let held = native::open_regular(path, false)?;
        if native::identity(&held)? != *expected {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        std::fs::remove_file(path)?;
    }
    Ok(())
}
