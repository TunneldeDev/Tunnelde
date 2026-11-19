use super::*;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn hosts_file_import(app: AppHandle) -> AppResult<Option<Preview>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tunnelde hosts", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|_| invalid())? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::settings_profiles::files::read_bytes(
            std::path::Path::new(&path.to_string()),
            MAX_BYTES,
        )
        .map_err(io_error)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
        let document: Document =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| invalid())?;
        app.state::<AppState>()
            .db
            .with(|conn| preview_at(conn, document))
            .map(Some)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}
#[tauri::command]
pub(crate) fn hosts_import_preview(app: AppHandle, document: Document) -> AppResult<Preview> {
    app.state::<AppState>()
        .db
        .with(|conn| preview_at(conn, document))
}
#[tauri::command]
pub(crate) async fn hosts_import_apply(
    app: AppHandle,
    request: ImportRequest,
) -> AppResult<Vec<Host>> {
    let state = app.state::<AppState>();
    let _commit = state.settings_commit.lock().await;
    let imported = state.db.with(|conn| apply_at(conn, request))?;
    publish(&app, &state, &imported)?;
    Ok(imported)
}
#[tauri::command]
pub(crate) async fn hosts_file_export(
    app: AppHandle,
    ids: Vec<String>,
) -> AppResult<Option<String>> {
    let text = app
        .state::<AppState>()
        .db
        .with(|conn| Ok(serde_json::to_vec_pretty(&export_at(conn, &ids)?)?))?;
    if text.len() > MAX_BYTES {
        return Err(invalid());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tunnelde hosts", &["json"])
        .set_file_name("tunnelde-hosts.json")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|_| invalid())? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let path = path.to_string();
        crate::settings_profiles::files::write_bytes(std::path::Path::new(&path), &text, MAX_BYTES)
            .map_err(io_error)?;
        Ok(Some(path))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

pub(crate) fn publish(app: &AppHandle, state: &AppState, imported: &[Host]) -> AppResult<()> {
    state.set_settings(state.db.with(db::settings::load_checked)?);
    super::super::service(app, state).published_import(imported);
    mounts::runtime::changed(app);
    for domain in ["forwards", "settings"] {
        let _ = app.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":domain}),
        );
    }
    Ok(())
}
fn io_error(error: AppError) -> AppError {
    match error {
        AppError::Validation(key) if key.starts_with("profiles.") => {
            AppError::validation(key.replacen("profiles.", "hostTransfer.", 1))
        }
        other => other,
    }
}
