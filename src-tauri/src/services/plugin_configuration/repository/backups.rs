use super::super::{
    contracts::document::{Backup, Stored},
    MAX_BACKUPS,
};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};

pub(in crate::services::plugin_configuration) fn list(
    conn: Option<&Connection>,
    id: &str,
) -> AppResult<Vec<Backup>> {
    let Some(conn) = conn else {
        return Ok(Vec::new());
    };
    let mut query = conn.prepare("SELECT id,created_at,reason,revision,version,digest,values_json FROM configuration_backups WHERE plugin_id=?1 ORDER BY created_at DESC,id LIMIT 9")?;
    let rows = query.query_map([id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, u32>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (id, created_at, reason, revision, version, digest, raw) = row?;
        result.push(Backup {
            id,
            created_at,
            reason,
            document: super::documents::decode(revision, version, digest, raw)?,
        });
    }
    if result.len() > MAX_BACKUPS {
        return Err(AppError::validation("configuration.corrupt"));
    }
    Ok(result)
}
pub(in crate::services::plugin_configuration) fn save(
    conn: &Connection,
    id: &str,
    doc: &Stored,
    reason: &str,
) -> AppResult<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM configuration_backups WHERE plugin_id=?1",
        [id],
        |row| row.get(0),
    )?;
    if count >= MAX_BACKUPS as i64 {
        return Err(AppError::validation("configuration.backupLimit"));
    }
    conn.execute("INSERT INTO configuration_backups (plugin_id,id,created_at,reason,revision,version,digest,values_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id,uuid::Uuid::new_v4().to_string(),chrono::Utc::now().to_rfc3339(),reason,doc.revision,doc.schema_version,doc.schema_digest,serde_json::to_string(&doc.values)?])?;
    Ok(())
}
pub(in crate::services::plugin_configuration) fn remove(
    conn: &Connection,
    id: &str,
    backup_id: &str,
) -> AppResult<()> {
    if conn.execute(
        "DELETE FROM configuration_backups WHERE plugin_id=?1 AND id=?2",
        params![id, backup_id],
    )? != 1
    {
        return Err(AppError::validation("configuration.backupNotFound"));
    }
    Ok(())
}
