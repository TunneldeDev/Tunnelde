//! Private user habits are independent of app/package versions and public settings.
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;
pub type Habits = BTreeMap<String, String>;
const KEY: &str = "user-habits-v1";
fn valid_key(key: &str) -> bool {
    key.starts_with("tunnelde.panels.")
        || key.starts_with("tunnelde:file-view:v1:")
        || key.starts_with("tunnelde:file-split:")
        || matches!(
            key,
            "tunnelde.filePreview.presentation"
                | "tunnelde.navigation"
                | "tunnelde.workspace.floating"
                | "tunnelde.backgroundTasks.bounds"
                | "tunnelde.transferPanel.bounds"
        )
}
fn validate(values: &Habits) -> AppResult<()> {
    if values.len() > 256
        || values
            .iter()
            .any(|(k, v)| !valid_key(k) || k.len() > 4096 || v.len() > 65536)
        || serde_json::to_vec(values)?.len() > 1_048_576
    {
        return Err(AppError::validation("invalid user habits"));
    }
    Ok(())
}
pub fn load(conn: &Connection) -> AppResult<Option<Habits>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|v| {
        let values: Habits = serde_json::from_str(&v)?;
        validate(&values)?;
        Ok(values)
    })
    .transpose()
}
pub fn save(conn: &Connection, values: &Habits) -> AppResult<()> {
    validate(values)?;
    conn.execute("INSERT INTO settings(key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![KEY,serde_json::to_string(values)?,crate::models::now_ms()])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_unrelated_settings_and_explicit_empty_reset() {
        let db = crate::db::Database::in_memory().unwrap();
        db.with(|c| {
            assert!(load(c)?.is_none());
            crate::db::settings::save(c, &Default::default())?;
            let data = Habits::from([(
                "tunnelde.panels.tasks.bounds".into(),
                r#"{"x":100,"y":200,"width":400,"height":300}"#.into(),
            )]);
            save(c, &data)?;
            assert_eq!(load(c)?, Some(data));
            save(c, &Habits::new())?;
            assert_eq!(load(c)?, Some(Habits::new()));
            assert_eq!(crate::db::settings::load(c)?.update_channel, "stable");
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn survives_database_reopen_without_browser_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("habits.db");
        let values = Habits::from([("tunnelde.panels.tasks.pinned".into(), "true".into())]);
        {
            let database = crate::db::Database::open(&path).unwrap();
            database.with(|conn| save(conn, &values)).unwrap();
        }
        let reopened = crate::db::Database::open(&path).unwrap();
        assert_eq!(reopened.with(load).unwrap(), Some(values));
    }
    #[test]
    fn rejects_unrelated_and_oversized_data() {
        assert!(validate(&Habits::from([("password".into(), "secret".into())])).is_err());
        assert!(validate(&Habits::from([(
            "tunnelde.navigation".into(),
            "x".repeat(65537)
        )]))
        .is_err());
    }
}
