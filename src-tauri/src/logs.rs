use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{db::Database, error::AppResult, models::now_ms, state::AppState};

const MAX_BYTES: u64 = 256 * 1024;
const MAX_AUDIT: i64 = 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    id: i64,
    timestamp: i64,
    action: String,
    target: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSnapshot {
    diagnostic: String,
    truncated: bool,
    filename: Option<String>,
    operations: Vec<AuditEntry>,
}

// Operation records contain only a fixed action and opaque object identifier.
pub fn record(db: &Database, action: &'static str, target: Option<&str>) {
    if let Err(error) = db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute("INSERT INTO audit_log (ts, action, target) VALUES (?1, ?2, ?3)",
            rusqlite::params![now_ms(), action, target])?;
        tx.execute("DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?1)", [MAX_AUDIT])?;
        tx.commit()?;
        Ok(())
    }) {
        tracing::warn!(%error, "Could not record operation");
    }
}

pub(crate) fn latest_name(dir: &Path) -> AppResult<Option<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = name.strip_prefix("tunnelde.log.").unwrap_or("");
        let valid = suffix.len() == 10
            && suffix.bytes().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == b'-'
                } else {
                    c.is_ascii_digit()
                }
            });
        if valid && entry.file_type()?.is_file() {
            names.push(name);
        }
    }
    names.sort_unstable();
    Ok(names.pop())
}

fn recent_file(dir: &Path) -> AppResult<(Option<String>, String, bool)> {
    let Some(name) = latest_name(dir)? else {
        return Ok((None, String::new(), false));
    };
    let mut file = std::fs::File::open(dir.join(&name))?;
    let len = file.metadata()?.len();
    let truncated = len > MAX_BYTES;
    file.seek(SeekFrom::Start(len.saturating_sub(MAX_BYTES)))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let text = if truncated {
        text.split_once('\n').map_or("", |(_, tail)| tail)
    } else {
        &text
    };
    Ok((Some(name), text.to_string(), truncated))
}

#[tauri::command]
pub async fn logs_read(app: AppHandle) -> AppResult<LogSnapshot> {
    let state = app.state::<AppState>();
    let operations = state.db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, ts, action, target FROM audit_log ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map([MAX_AUDIT], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                action: row.get(2)?,
                target: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })?;
    let dir = state.log_dir.clone();
    let (filename, diagnostic, truncated) =
        tauri::async_runtime::spawn_blocking(move || recent_file(&dir))
            .await
            .map_err(|error| crate::error::AppError::internal(error.to_string()))??;
    Ok(LogSnapshot {
        diagnostic,
        truncated,
        filename,
        operations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn latest_log_selects_daily_files_and_ignores_directories_and_links() {
        let dir = std::env::temp_dir().join(format!("tunnelde-logs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(latest_name(&dir).unwrap(), None);
        for name in ["tunnelde.log.2026-11-05", "tunnelde.log.2026-11-06"] {
            std::fs::write(dir.join(name), "log").unwrap();
        }
        std::fs::create_dir(dir.join("tunnelde.log.2026-11-07")).unwrap();
        std::fs::write(dir.join("tunnelde.log.2026-11-08.bak"), "ignored").unwrap();
        std::fs::write(dir.join("tunnelde.log.current"), "ignored").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            dir.join("tunnelde.log.2026-11-05"),
            dir.join("tunnelde.log.2026-11-09"),
        )
        .unwrap();
        assert_eq!(
            latest_name(&dir).unwrap().as_deref(),
            Some("tunnelde.log.2026-11-06")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn operation_history_is_bounded_and_newest_first() {
        let db = Database::in_memory().unwrap();
        for _ in 0..1002 {
            record(&db, "host.create", None);
        }
        db.with(|conn| {
            let (count, first): (i64, i64) =
                conn.query_row("SELECT count(*), min(id) FROM audit_log", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
            assert_eq!((count, first), (1000, 3));
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn recent_log_is_bounded_and_ignores_unrelated_files() {
        let dir = std::env::temp_dir().join(format!("tunnelde-logs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("unrelated"), "secret").unwrap();
        std::fs::write(
            dir.join("tunnelde.log.2026-11-05"),
            format!("{}\nlast line\n", "a".repeat(MAX_BYTES as usize)),
        )
        .unwrap();
        let (name, text, truncated) = recent_file(&dir).unwrap();
        assert_eq!(name.as_deref(), Some("tunnelde.log.2026-11-05"));
        assert!(truncated);
        assert_eq!(text, "last line\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
