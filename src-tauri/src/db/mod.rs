// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

pub mod history;
pub mod hosts;
pub mod known_hosts;
pub mod migrations;
pub mod settings;
pub mod tabs;

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

/// SQLite handle shared by every command. WAL keeps reads fast while a
/// write is in flight; `foreign_keys` is enabled per connection.
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let database = Self {
            conn: Mutex::new(conn),
        };
        database.migrate()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let database = Self {
            conn: Mutex::new(conn),
        };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&self) -> AppResult<()> {
        self.with(|conn| {
            let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            let applied = version.max(0) as usize;
            if applied > migrations::MIGRATIONS.len() {
                return Err(AppError::internal(
                    "database schema is newer than this build",
                ));
            }
            for (index, sql) in migrations::MIGRATIONS.iter().enumerate().skip(applied) {
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", (index + 1) as i64)?;
                tx.commit()?;
            }
            Ok(())
        })
    }

    pub fn with<T>(&self, run: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| AppError::internal("database lock poisoned"))?;
        run(&guard)
    }
}
