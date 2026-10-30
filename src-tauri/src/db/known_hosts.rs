// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;
use crate::models::now_ms;

pub struct KnownHost {
    pub fingerprint: String,
}

pub fn find(conn: &Connection, host: &str, port: i64) -> AppResult<Option<KnownHost>> {
    Ok(conn
        .query_row(
            "SELECT fingerprint FROM known_hosts WHERE host = ?1 AND port = ?2",
            params![host, port],
            |row| {
                Ok(KnownHost {
                    fingerprint: row.get(0)?,
                })
            },
        )
        .optional()?)
}

pub fn upsert(
    conn: &Connection,
    host: &str,
    port: i64,
    algorithm: &str,
    fingerprint: &str,
) -> AppResult<()> {
    let timestamp = now_ms();
    conn.execute(
        "INSERT INTO known_hosts (host, port, algorithm, fingerprint, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(host, port) DO UPDATE SET
            algorithm = excluded.algorithm,
            fingerprint = excluded.fingerprint,
            updated_at = excluded.updated_at",
        params![host, port, algorithm, fingerprint, timestamp],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn stores_and_replaces_fingerprints() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            assert!(find(conn, "example.com", 22)?.is_none());

            upsert(conn, "example.com", 22, "ssh-ed25519", "SHA256:aaa")?;
            assert_eq!(
                find(conn, "example.com", 22)?.map(|entry| entry.fingerprint),
                Some("SHA256:aaa".to_string())
            );

            upsert(conn, "example.com", 22, "ssh-ed25519", "SHA256:bbb")?;
            let stored = find(conn, "example.com", 22)?.expect("known host");
            assert_eq!(stored.fingerprint, "SHA256:bbb");
            Ok(())
        })
        .expect("known hosts");
    }
}
