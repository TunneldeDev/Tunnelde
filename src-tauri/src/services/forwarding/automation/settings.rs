//! Native opt-in settings are separate from the stable plugin rule DTO.
use super::Options;
use crate::error::AppResult;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Stored {
    revision: String,
    options: Options,
}
fn key(id: &str) -> String {
    format!("forward-automation:{id}")
}
pub(in crate::services::forwarding) fn read(
    conn: &Connection,
    id: &str,
    revision: &str,
) -> AppResult<Options> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [key(id)],
            |row| row.get(0),
        )
        .optional()?;
    let stored = raw
        .map(|raw| serde_json::from_str::<Stored>(&raw))
        .transpose()?;
    Ok(stored
        .filter(|value| value.revision == revision)
        .map(|value| value.options)
        .unwrap_or_default())
}
pub(in crate::services::forwarding) fn write(
    conn: &Connection,
    id: &str,
    revision: &str,
    options: Options,
) -> AppResult<()> {
    if options == Options::default() {
        return clear(conn, id);
    }
    conn.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![key(id), serde_json::to_string(&Stored { revision: revision.into(), options })?, crate::models::now_ms()],
    )?;
    Ok(())
}
pub(in crate::services::forwarding) fn clear(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key=?1", [key(id)])?;
    Ok(())
}
