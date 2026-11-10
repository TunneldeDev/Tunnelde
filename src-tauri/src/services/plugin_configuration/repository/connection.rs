use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Repository {
    path: PathBuf,
}
impl Repository {
    pub fn at(root: &Path) -> Self {
        Self {
            path: root.join("configuration.sqlite3"),
        }
    }

    /// No file or directory creation on a read. Short connections close before storage migration.
    pub(in crate::services::plugin_configuration) fn read<T>(
        &self,
        read: impl FnOnce(Option<&Connection>) -> AppResult<T>,
    ) -> AppResult<T> {
        let conn = match Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(conn) => conn,
            Err(error) => {
                if !self.path.try_exists()? {
                    return read(None);
                }
                return Err(error.into());
            }
        };
        conn.busy_timeout(Duration::from_millis(1000))?;
        if database_version(&conn)? == 0 {
            return read(None);
        }
        read(Some(&conn))
    }

    pub(in crate::services::plugin_configuration) fn write<T>(
        &self,
        write: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        std::fs::create_dir_all(
            self.path
                .parent()
                .ok_or_else(|| AppError::internal("configuration.storage"))?,
        )?;
        let mut conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_millis(1000))?;
        // DELETE journaling leaves no live WAL outside the migratable data directory.
        conn.pragma_update(None, "journal_mode", "DELETE")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if database_version(&tx)? == 0 {
            tx.execute_batch("CREATE TABLE configuration_documents (
            plugin_id TEXT PRIMARY KEY, revision TEXT NOT NULL, version INTEGER NOT NULL,
            digest TEXT NOT NULL, values_json TEXT NOT NULL);
            CREATE TABLE configuration_backups (
            plugin_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL,
            revision TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, values_json TEXT NOT NULL,
            PRIMARY KEY(plugin_id,id)); PRAGMA user_version=1;")?;
        }
        let result = write(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}

fn database_version(conn: &Connection) -> AppResult<i64> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version == 0 {
        let tables: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if tables == 0 {
            return Ok(0);
        }
    } else if version == 1 {
        return Ok(1);
    }
    Err(AppError::validation("configuration.storageVersion"))
}
