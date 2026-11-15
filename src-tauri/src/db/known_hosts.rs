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
    super::atomic(conn, |conn| {
        let previous: Option<(String, String)> = conn
            .query_row(
                "SELECT algorithm,fingerprint FROM known_hosts WHERE host=?1 AND port=?2",
                params![host, port],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
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
        if previous
            .as_ref()
            .is_none_or(|(a, f)| a != algorithm || f != fingerprint)
        {
            crate::services::credentials::lifecycle::trust_changed(conn, host, port)?;
        }
        Ok(())
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: i64,
    pub algorithm: String,
    pub fingerprint: String,
    pub updated_at: i64,
}

pub fn list(conn: &Connection) -> AppResult<Vec<KnownHostEntry>> {
    let mut statement = conn.prepare(
        "SELECT host, port, algorithm, fingerprint, updated_at
         FROM known_hosts
         ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(KnownHostEntry {
            host: row.get(0)?,
            port: row.get(1)?,
            algorithm: row.get(2)?,
            fingerprint: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn forget(conn: &Connection, host: &str, port: i64) -> AppResult<bool> {
    super::atomic(conn, |conn| {
        let removed = conn.execute(
            "DELETE FROM known_hosts WHERE host = ?1 AND port = ?2",
            params![host, port],
        )?;
        if removed > 0 {
            crate::services::credentials::lifecycle::trust_changed(conn, host, port)?;
        }
        Ok(removed > 0)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn trust_metadata_failure_rolls_back_update_and_forget_even_in_outer_transactions() {
        Database::in_memory().unwrap().with(|conn| {
            upsert(conn,"qa.example",22,"ssh-ed25519","SHA256:original")?;
            conn.execute_batch("CREATE TRIGGER refuse_trust BEFORE UPDATE ON settings WHEN NEW.key LIKE 'credentials.trust.%' BEGIN SELECT RAISE(ABORT,'controlled trust metadata failure'); END;")?;
            let tx=conn.unchecked_transaction()?;
            assert!(upsert(&tx,"qa.example",22,"ssh-ed25519","SHA256:changed").is_err());
            assert!(forget(&tx,"qa.example",22).is_err());
            assert_eq!(find(&tx,"qa.example",22)?.unwrap().fingerprint,"SHA256:original");
            tx.commit()?; Ok(())
        }).unwrap();
    }

    #[test]
    fn lists_and_forgets_trusted_hosts() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            upsert(conn, "one.example", 22, "ssh-ed25519", "SHA256:one")?;
            upsert(conn, "two.example", 2222, "ssh-rsa", "SHA256:two")?;

            let entries = list(conn)?;
            assert_eq!(entries.len(), 2);

            assert!(forget(conn, "one.example", 22)?);
            assert!(!forget(conn, "one.example", 22)?);
            let remaining = list(conn)?;
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0].host, "two.example");
            Ok(())
        })
        .expect("known hosts list");
    }
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
