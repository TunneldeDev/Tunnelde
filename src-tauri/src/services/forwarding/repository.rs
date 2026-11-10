//! Persisted rules only. The domain service coordinates these commits with runtime admission.
use super::contract::ForwardRule;
use crate::{db::Database, error::AppResult};

fn key(id: &str) -> String {
    format!("forward:{id}")
}
pub(super) fn list(db: &Database) -> AppResult<Vec<ForwardRule>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT value FROM settings WHERE key LIKE 'forward:%' ORDER BY updated_at DESC",
        )?;
        let raw = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut result = Vec::new();
        for item in raw {
            result.push(serde_json::from_str(&item?)?);
        }
        Ok(result)
    })
}

pub(super) fn save(db: &Database, rule: &ForwardRule) -> AppResult<ForwardRule> {
    db.with(|conn| {
        crate::db::hosts::find_host(conn, &rule.host_id)?;
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![key(&rule.id), serde_json::to_string(rule)?, crate::models::now_ms()])?;
        Ok(rule.clone())
    })
}
pub(super) fn remove(db: &Database, id: &str) -> AppResult<bool> {
    db.with(|conn| Ok(conn.execute("DELETE FROM settings WHERE key=?1", [key(id)])? != 0))
}
