//! Explicit private database creation and fail-closed reopening.
use super::{Error, Journal, Result};
use crate::{platform::editor_file, ssh::files::native_save::contracts};
use rusqlite::{Connection, OpenFlags};
use std::{fs::File, path::Path, time::Duration};
const APPLICATION: i64 = 0x544e4653;
impl Journal {
    /// Explicit initialization only. A partial/failed initialization is retained.
    pub fn create(directory: &Path) -> Result<Self> {
        editor_file::private_directory(directory).map_err(|_| Error::Unavailable)?;
        // macOS temporary storage uses an ancestor /var -> /private/var alias.
        // Preserve the selected directory identity while resolving ancestor aliases
        // before SQLite NOFOLLOW checks every path component.
        let identity =
            editor_file::directory_identity(directory).map_err(|_| Error::Unrecognized)?;
        let directory = directory.canonicalize().map_err(|_| Error::Unavailable)?;
        if editor_file::directory_identity(&directory).map_err(|_| Error::Unrecognized)? != identity
        {
            return Err(Error::Changed);
        }
        let path = directory.join("recovery.sqlite3");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| Error::Unavailable)?;
        file.sync_all().map_err(|_| Error::Unavailable)?;
        drop(file);
        let conn = connect(&path)?;
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
             CREATE TABLE records(id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                                  value TEXT NOT NULL, digest TEXT NOT NULL);
             PRAGMA application_id=1414415955;
             PRAGMA user_version=1;"
        ).map_err(|_| Error::Unavailable)?;
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute("INSERT INTO metadata VALUES(1,?1)", [&id])
            .map_err(|_| Error::Unavailable)?;
        conn.execute_batch("COMMIT")
            .map_err(|_| Error::Unavailable)?;
        drop(conn);
        // SQLite FULL/EXTRA syncs transactions; initial directory entries also need syncing.
        #[cfg(unix)]
        for parent in [Some(directory.as_path()), directory.parent()]
            .into_iter()
            .flatten()
        {
            File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|_| Error::Unavailable)?;
        }
        Self::open(&directory)
    }
    pub fn open(directory: &Path) -> Result<Self> {
        let directory_identity =
            editor_file::directory_identity(directory).map_err(|_| Error::Unrecognized)?;
        let directory = directory.canonicalize().map_err(|_| Error::Unavailable)?;
        let path = directory.join("recovery.sqlite3");
        let file_identity = file_identity(&path)?;
        let conn = connect(&path)?;
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|_| Error::Unrecognized)?;
        let application: i64 = conn
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(|_| Error::Unrecognized)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| Error::Unrecognized)?;
        if check != "ok" || application != APPLICATION || version != 1 {
            return Err(Error::Unrecognized);
        }
        let id: String = conn
            .query_row("SELECT id FROM metadata WHERE singleton=1", [], |row| {
                row.get(0)
            })
            .map_err(|_| Error::Unrecognized)?;
        if !contracts::uuid(&id) {
            return Err(Error::Unrecognized);
        }
        let journal = Self {
            conn,
            directory,
            directory_identity,
            file_identity,
            id,
        };
        journal.verify()?;
        journal.records()?;
        Ok(journal)
    }
    pub(super) fn verify(&self) -> Result<()> {
        if editor_file::directory_identity(&self.directory).map_err(|_| Error::Unrecognized)?
            != self.directory_identity
            || file_identity(&self.directory.join("recovery.sqlite3"))? != self.file_identity
        {
            return Err(Error::Changed);
        }
        let id: String = self
            .conn
            .query_row("SELECT id FROM metadata WHERE singleton=1", [], |row| {
                row.get(0)
            })
            .map_err(|_| Error::Unrecognized)?;
        if id != self.id {
            return Err(Error::Changed);
        }
        Ok(())
    }
}
fn connect(path: &Path) -> Result<Connection> {
    // READ_WRITE intentionally lacks CREATE. Existing empty/corrupt stores stay failed.
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| Error::Unavailable)?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|_| Error::Unavailable)?;
    conn.execute_batch(
        "PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;",
    )
    .map_err(|_| Error::Unavailable)?;
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| Error::Unavailable)?;
    if !matches!(mode.as_str(), "delete" | "wal") {
        return Err(Error::Unrecognized);
    }
    Ok(conn)
}
fn file_identity(path: &Path) -> Result<editor_file::Identity> {
    if crate::storage::layout::metadata(path)
        .map_err(|_| Error::Unavailable)?
        .is_none_or(|metadata| !metadata.is_file() || crate::storage::layout::linked(&metadata))
    {
        return Err(Error::Unrecognized);
    }
    let file = File::open(path).map_err(|_| Error::Unavailable)?;
    editor_file::identity(&file).map_err(|_| Error::Unrecognized)
}
