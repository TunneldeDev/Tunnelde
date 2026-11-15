//! Internal durable lineage tokens. Values contain no endpoints or secrets.
use super::*;
use rusqlite::OptionalExtension;

pub(super) fn rotate(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![key, Uuid::new_v4().to_string(), crate::models::now_ms()],
    )?;
    Ok(())
}

pub(super) fn read(conn: &Connection, key: &str) -> AppResult<Option<Uuid>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|raw| {
        let id = Uuid::parse_str(&raw)
            .map_err(|_| crate::error::AppError::internal("credentials.invalidMetadata"))?;
        if id.get_version_num() != 4 || id.to_string() != raw {
            return Err(crate::error::AppError::internal(
                "credentials.invalidMetadata",
            ));
        }
        Ok(id)
    })
    .transpose()
}
