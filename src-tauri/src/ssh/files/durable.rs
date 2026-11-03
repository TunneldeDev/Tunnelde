use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableTransfer {
    pub id: String,
    pub direction: String,
    pub name: String,
    pub from_session: Option<String>,
    pub from_host_id: Option<String>,
    pub from_path: String,
    pub to_session: Option<String>,
    pub to_host_id: Option<String>,
    pub to_path: String,
    pub remove_source: bool,
    #[serde(default)]
    pub deleting_source: bool,
    pub overwrite: bool,
    pub transferred: u64,
    pub total: u64,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: i64,
}
pub struct Journal;
impl Journal {
    pub fn upsert(app: &AppHandle, row: DurableTransfer) -> AppResult<()> {
        app.state::<AppState>().db.with(|conn| {conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![format!("transfer:{}",row.id),serde_json::to_string(&row)?,row.updated_at])?; Ok(())})
    }
    pub fn list(app: &AppHandle) -> AppResult<Vec<DurableTransfer>> {
        app.state::<AppState>().db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT value FROM settings WHERE key LIKE 'transfer:%' ORDER BY updated_at",
            )?;
            let values = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for value in values {
                out.push(serde_json::from_str(&value?)?);
            }
            Ok(out)
        })
    }
    pub fn get(app: &AppHandle, id: &str) -> AppResult<DurableTransfer> {
        app.state::<AppState>().db.with(|conn| {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM settings WHERE key=?1",
                    [format!("transfer:{id}")],
                    |r| r.get(0),
                )
                .optional()?;
            let raw = raw.ok_or_else(|| AppError::NotFound("sftp.transferNotFound".into()))?;
            Ok(serde_json::from_str(&raw)?)
        })
    }
    pub fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
        app.state::<AppState>().db.with(|conn| {
            conn.execute(
                "DELETE FROM settings WHERE key=?1 OR instr(key,?2)=1 OR instr(key,?3)=1",
                rusqlite::params![
                    format!("transfer:{id}"),
                    format!("transfer-file:{id}:"),
                    format!("transfer-backup:{id}:")
                ],
            )?;
            Ok(())
        })
    }
}
#[tauri::command]
pub fn durable_transfer_list(app: AppHandle) -> AppResult<Vec<DurableTransfer>> {
    let mut rows = Journal::list(&app)?;
    for row in &mut rows {
        if row.status == "running" && !app.state::<AppState>().transfers.is_active(&row.id) {
            row.status = "paused".into();
            row.error = Some("sftp.restartRecovery".into());
        }
    }
    Ok(rows)
}
#[tauri::command]
pub fn durable_transfer_clear(app: AppHandle, id: String) -> AppResult<()> {
    if app.state::<AppState>().transfers.is_active(&id) {
        return Err(AppError::validation("sftp.transferBusy"));
    }
    Journal::remove(&app, &id)
}
#[tauri::command]
pub fn durable_transfer_pause(app: AppHandle, id: String) -> AppResult<()> {
    let _ = Journal::get(&app, &id)?;
    app.state::<AppState>().transfers.pause(&id);
    Ok(())
}
#[tauri::command]
pub fn durable_transfer_resume(app: AppHandle, id: String) -> AppResult<()> {
    let row = Journal::get(&app, &id)?;
    let sessions = app.state::<AppState>().ssh.list();
    let resolve = |host: Option<String>, old: Option<String>| -> AppResult<Option<String>> {
        match host {
            Some(host) => sessions
                .iter()
                .find(|s| s.host_id == host)
                .map(|s| Some(s.id.clone()))
                .ok_or_else(|| AppError::validation("sftp.reconnectRequired")),
            None => {
                if old.is_some() {
                    Err(AppError::validation("sftp.reconnectRequired"))
                } else {
                    Ok(None)
                }
            }
        }
    };
    let from = super::Endpoint {
        session: resolve(row.from_host_id.clone(), row.from_session.clone())?,
        path: row.from_path.clone(),
    };
    let to = super::Endpoint {
        session: resolve(row.to_host_id.clone(), row.to_session.clone())?,
        path: row.to_path.clone(),
    };
    super::resume_transfer(app, from, to, row)
}
