use super::super::{contracts::document::Stored, MAX_DOCUMENT};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};

pub(super) fn decode(
    revision: String,
    version: u32,
    digest: String,
    raw: String,
) -> AppResult<Stored> {
    if raw.len() > MAX_DOCUMENT
        || uuid::Uuid::parse_str(&revision).is_err()
        || version == 0
        || !super::super::schema::digest_string(&digest)
    {
        return Err(AppError::validation("configuration.corrupt"));
    }
    Ok(Stored {
        revision,
        schema_version: version,
        schema_digest: digest,
        values: serde_json::from_str(&raw)
            .map_err(|_| AppError::validation("configuration.corrupt"))?,
    })
}
pub(in crate::services::plugin_configuration) fn get(
    conn: Option<&Connection>,
    id: &str,
) -> AppResult<Option<Stored>> {
    let Some(conn) = conn else {
        return Ok(None);
    };
    let row: Option<(String,u32,String,String)> = conn.query_row(
        "SELECT revision,version,digest,values_json FROM configuration_documents WHERE plugin_id=?1",[id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
    row.map(|(rev, version, digest, raw)| decode(rev, version, digest, raw))
        .transpose()
}
pub(in crate::services::plugin_configuration) fn put(
    conn: &Connection,
    id: &str,
    doc: &Stored,
) -> AppResult<()> {
    let raw = serde_json::to_string(&doc.values)?;
    if raw.len() > MAX_DOCUMENT {
        return Err(AppError::validation("configuration.limit"));
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM configuration_documents", [], |row| {
        row.get(0)
    })?;
    if count >= 4096 && get(Some(conn), id)?.is_none() {
        return Err(AppError::validation("configuration.limit"));
    }
    let bytes: i64 = conn.query_row("SELECT COALESCE(SUM(length(CAST(values_json AS BLOB))),0) FROM configuration_documents WHERE plugin_id<>?1",[id],|row|row.get(0))?;
    let backups: i64 = conn.query_row(
        "SELECT COALESCE(SUM(length(CAST(values_json AS BLOB))),0) FROM configuration_backups",
        [],
        |row| row.get(0),
    )?;
    if bytes + backups + raw.len() as i64 > 64 * 1024 * 1024 {
        return Err(AppError::validation("configuration.limit"));
    }
    conn.execute("INSERT INTO configuration_documents (plugin_id,revision,version,digest,values_json) VALUES (?1,?2,?3,?4,?5)
        ON CONFLICT(plugin_id) DO UPDATE SET revision=excluded.revision,version=excluded.version,digest=excluded.digest,values_json=excluded.values_json",
        params![id,doc.revision,doc.schema_version,doc.schema_digest,raw])?;
    Ok(())
}
