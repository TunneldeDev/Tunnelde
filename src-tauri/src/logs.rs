use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{db::Database, error::AppResult, models::now_ms, state::AppState};

const MAX_BYTES: u64 = 256 * 1024;
const MAX_AUDIT: i64 = 1000;

pub(crate) mod read;

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

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputCursor {
    filename: Option<String>,
    offset: u64,
    operation_id: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSnapshot {
    diagnostic: String,
    operations: Vec<AuditEntry>,
    cursor: OutputCursor,
    truncated: bool,
}

/// Only the current rotated log is read. A cursor never selects a filesystem path.
fn output_tail(dir: &Path, cursor: &OutputCursor) -> AppResult<(OutputCursor, String, bool)> {
    let filename = latest_name(dir)?;
    let mut next = OutputCursor {
        filename: filename.clone(),
        operation_id: cursor.operation_id,
        ..Default::default()
    };
    let Some(filename) = filename else {
        return Ok((next, String::new(), false));
    };
    let mut file = std::fs::File::open(dir.join(filename))?;
    let len = file.metadata()?.len();
    let offset = if cursor.filename == next.filename && cursor.offset <= len {
        cursor.offset
    } else {
        0
    };
    let start = offset.max(len.saturating_sub(MAX_BYTES));
    let truncated = start > offset;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes)?;
    let first = if truncated {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|i| i + 1)
            .unwrap_or(bytes.len())
    } else {
        0
    };
    // Keep incomplete UTF-8 and JSON lines for the next poll, never duplicate them.
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    next.offset = start + end.max(first) as u64;
    Ok((
        next,
        String::from_utf8_lossy(&bytes[first..end.max(first)]).into_owned(),
        truncated,
    ))
}

#[tauri::command]
pub async fn logs_output_read(
    app: AppHandle,
    cursor: Option<OutputCursor>,
) -> AppResult<OutputSnapshot> {
    let cursor = cursor.unwrap_or_default();
    let state = app.state::<AppState>();
    let operations = state.db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, ts, action, target FROM audit_log WHERE id > ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![cursor.operation_id, MAX_AUDIT], |row| {
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
    let (mut cursor, diagnostic, truncated) =
        tauri::async_runtime::spawn_blocking(move || output_tail(&dir, &cursor))
            .await
            .map_err(|error| crate::error::AppError::internal(error.to_string()))??;
    cursor.operation_id = operations
        .first()
        .map_or(cursor.operation_id, |entry| entry.id);
    Ok(OutputSnapshot {
        diagnostic,
        operations,
        cursor,
        truncated,
    })
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
        let _ = crate::diagnostics::write(
            crate::diagnostics::LogOrigin::Native,
            crate::diagnostics::LogEntry {
                level: crate::diagnostics::LogLevel::Warn,
                domain: Some("operations".into()),
                operation: Some(action.into()),
                message: format!("Could not record operation: {error}"),
                ..Default::default()
            },
        );
    }
}

pub(crate) fn latest_name(dir: &Path) -> AppResult<Option<String>> {
    select_name(dir, None)
}

/// Public plugin reads have a separate metadata work budget; native Output
/// retains its existing selection behavior and wire contract.
fn select_name(dir: &Path, limit: Option<usize>) -> AppResult<Option<String>> {
    let mut names = Vec::new();
    for (index, entry) in std::fs::read_dir(dir)?.enumerate() {
        if limit.is_some_and(|limit| index >= limit) {
            return Err(crate::error::AppError::validation("logs.read.unavailable"));
        }
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = name
            .strip_suffix(".tunnelde.jsonl.log")
            .or_else(|| name.strip_suffix(".tunnelde.log"))
            .or_else(|| name.strip_prefix("tunnelde.log."))
            .unwrap_or("");
        let valid = suffix.len() == 10
            && suffix.bytes().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == b'-'
                } else {
                    c.is_ascii_digit()
                }
            });
        if valid && entry.file_type()?.is_file() {
            // The date is the primary key across both naming generations.
            let preferred = name.ends_with(".tunnelde.jsonl.log");
            names.push((suffix.to_string(), preferred, name));
        }
    }
    names.sort_unstable();
    Ok(names.pop().map(|(_, _, name)| name))
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
    fn output_cursor_reads_only_new_complete_lines_and_handles_rotation_and_truncation() {
        let dir = std::env::temp_dir().join(format!("tunnelde-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-11-08.tunnelde.jsonl.log");
        std::fs::write(&path, "first\n中").unwrap();
        let (cursor, text, _) = output_tail(&dir, &OutputCursor::default()).unwrap();
        assert_eq!(text, "first\n");
        assert_eq!(cursor.offset, 6);
        std::fs::write(&path, "first\n中文\n").unwrap();
        let (cursor, text, _) = output_tail(&dir, &cursor).unwrap();
        assert_eq!(text, "中文\n");
        assert_eq!(output_tail(&dir, &cursor).unwrap().1, "");
        std::fs::write(&path, "reset\n").unwrap();
        let (cursor, text, _) = output_tail(&dir, &cursor).unwrap();
        assert_eq!(text, "reset\n");
        std::fs::write(dir.join("2026-11-09.tunnelde.jsonl.log"), "rotated\n").unwrap();
        assert_eq!(output_tail(&dir, &cursor).unwrap().1, "rotated\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn output_tail_bounds_oversized_lines_and_prefers_new_names_for_same_date() {
        let dir = std::env::temp_dir().join(format!("tunnelde-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tunnelde.log.2026-11-08"), "legacy\n").unwrap();
        let path = dir.join("2026-11-08.tunnelde.jsonl.log");
        std::fs::write(
            &path,
            format!("{}\ntail\n", "x".repeat(MAX_BYTES as usize + 10)),
        )
        .unwrap();
        let (cursor, text, truncated) = output_tail(&dir, &OutputCursor::default()).unwrap();
        assert!(truncated);
        assert_eq!(text, "tail\n");
        assert_eq!(
            cursor.filename.as_deref(),
            Some("2026-11-08.tunnelde.jsonl.log")
        );
        assert_eq!(output_tail(&dir, &cursor).unwrap().1, "");
        // Mixed generations must sort by date, not their different prefixes.
        std::fs::write(dir.join("tunnelde.log.2026-11-09"), "newer legacy\n").unwrap();
        assert_eq!(output_tail(&dir, &cursor).unwrap().1, "newer legacy\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
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
