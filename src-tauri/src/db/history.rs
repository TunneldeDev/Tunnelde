// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use rusqlite::{params, Connection};

use crate::error::AppResult;
use crate::models::now_ms;

pub const MAX_PER_HOST: i64 = 500;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub host_id: String,
    pub command: String,
    pub executed_at: i64,
}

pub fn record(conn: &Connection, host_id: &str, command: &str) -> AppResult<Option<HistoryEntry>> {
    let command = command.trim();
    if command.is_empty() || command.len() > 4000 {
        return Ok(None);
    }

    let timestamp = now_ms();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM command_history WHERE host_id = ?1 AND command = ?2",
        params![host_id, command],
    )?;
    tx.execute(
        "INSERT INTO command_history (host_id, command, executed_at) VALUES (?1, ?2, ?3)",
        params![host_id, command, timestamp],
    )?;
    tx.execute(
        "DELETE FROM command_history
         WHERE host_id = ?1 AND id NOT IN (
             SELECT id FROM command_history
             WHERE host_id = ?1
             ORDER BY executed_at DESC, id DESC
             LIMIT ?2
         )",
        params![host_id, MAX_PER_HOST],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;

    Ok(Some(HistoryEntry {
        id,
        host_id: host_id.to_string(),
        command: command.to_string(),
        executed_at: timestamp,
    }))
}

pub fn list(conn: &Connection, host_id: &str, limit: i64) -> AppResult<Vec<HistoryEntry>> {
    let mut statement = conn.prepare(
        "SELECT id, host_id, command, executed_at
         FROM command_history
         WHERE host_id = ?1
         ORDER BY executed_at DESC, id DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![host_id, limit.clamp(1, MAX_PER_HOST)], |row| {
        Ok(HistoryEntry {
            id: row.get(0)?,
            host_id: row.get(1)?,
            command: row.get(2)?,
            executed_at: row.get(3)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM command_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear(conn: &Connection, host_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM command_history WHERE host_id = ?1",
        params![host_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::HostInput;

    fn host(db: &Database, name: &str) -> String {
        let draft = HostInput {
            name: name.into(),
            group_id: None,
            host: "example.com".into(),
            port: Some(22),
            username: Some("root".into()),
            auth_method: Some("password".into()),
            key_path: None,
            favorite: false,
            color: None,
            tags: Vec::new(),
            note: None,
        }
        .validate()
        .expect("valid host");

        db.with(|conn| crate::db::hosts::create_host(conn, &draft))
            .expect("host")
            .id
    }

    #[test]
    fn records_and_lists_commands() {
        let db = Database::in_memory().expect("database");
        let host_id = host(&db, "alpha");

        db.with(|conn| {
            record(conn, &host_id, "ls -la")?;
            record(conn, &host_id, "uptime")?;
            let entries = list(conn, &host_id, 10)?;
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].command, "uptime");
            Ok(())
        })
        .expect("history");
    }

    #[test]
    fn moves_a_repeated_command_to_the_top() {
        let db = Database::in_memory().expect("database");
        let host_id = host(&db, "alpha");

        db.with(|conn| {
            record(conn, &host_id, "ls")?;
            record(conn, &host_id, "pwd")?;
            record(conn, &host_id, "ls")?;
            let entries = list(conn, &host_id, 10)?;
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].command, "ls");
            Ok(())
        })
        .expect("dedupe");
    }

    #[test]
    fn ignores_blank_commands() {
        let db = Database::in_memory().expect("database");
        let host_id = host(&db, "alpha");

        db.with(|conn| {
            assert!(record(conn, &host_id, "   ")?.is_none());
            assert_eq!(list(conn, &host_id, 10)?.len(), 0);
            Ok(())
        })
        .expect("blank");
    }

    #[test]
    fn caps_the_history_per_host() {
        let db = Database::in_memory().expect("database");
        let host_id = host(&db, "alpha");

        db.with(|conn| {
            for index in 0..(MAX_PER_HOST + 5) {
                record(conn, &host_id, &format!("cmd {index}"))?;
            }
            let entries = list(conn, &host_id, MAX_PER_HOST)?;
            assert_eq!(entries.len() as i64, MAX_PER_HOST);
            assert_eq!(entries[0].command, format!("cmd {}", MAX_PER_HOST + 4));
            Ok(())
        })
        .expect("cap");
    }

    #[test]
    fn deletes_and_clears() {
        let db = Database::in_memory().expect("database");
        let host_id = host(&db, "alpha");

        db.with(|conn| {
            let entry = record(conn, &host_id, "rm -rf /tmp/x")?.expect("entry");
            delete(conn, entry.id)?;
            assert_eq!(list(conn, &host_id, 10)?.len(), 0);

            record(conn, &host_id, "a")?;
            record(conn, &host_id, "b")?;
            clear(conn, &host_id)?;
            assert_eq!(list(conn, &host_id, 10)?.len(), 0);
            Ok(())
        })
        .expect("delete");
    }
}
