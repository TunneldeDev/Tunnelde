use super::*;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FontTarget {
    Ui,
    Mono,
    EditorCjk,
}

#[tauri::command]
pub(crate) async fn fonts_select(
    app: AppHandle,
    target: FontTarget,
    reference: Option<FontReference>,
) -> AppResult<crate::settings::Settings> {
    if reference.as_ref().is_some_and(|value| !value.valid()) {
        return Err(invalid());
    }
    let worker = app.clone();
    crate::services::settings::write(&app, move |writer| {
        let state = worker.state::<crate::state::AppState>();
        let mut selections = state.settings().font_selections;
        match target {
            FontTarget::Ui => selections.ui = reference,
            FontTarget::Mono => selections.mono = reference,
            FontTarget::EditorCjk => selections.editor_cjk = reference,
        }
        writer.update(serde_json::json!({"fontSelections":selections}))
    })
    .await
}

#[tauri::command]
pub(crate) async fn fonts_catalogue(app: AppHandle, refresh: bool) -> AppResult<FontCatalogue> {
    catalogue(&app, refresh).await
}

#[tauri::command]
pub(crate) async fn fonts_import(app: AppHandle) -> AppResult<Option<FontImport>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Fonts", &["ttf", "otf", "woff", "woff2"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|_| invalid())?;
    tauri::async_runtime::spawn_blocking(move || repository::stage(&app, &path).map(Some))
        .await
        .map_err(|_| AppError::internal("fonts.unavailableError"))?
}

#[tauri::command]
pub(crate) async fn fonts_finish_import(
    app: AppHandle,
    token: String,
    accepted: bool,
    monospaced: bool,
) -> AppResult<Option<FontInfo>> {
    let registry = app.state::<Registry>();
    let _serial = registry.mutation.lock().await;
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        repository::finish(&worker, &token, accepted, monospaced)
    })
    .await
    .map_err(|_| AppError::internal("fonts.unavailableError"))??;
    if accepted {
        let _ = app.emit("fonts://changed", ());
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn fonts_remove(app: AppHandle, id: String) -> AppResult<()> {
    if !valid_id(&id) {
        return Err(invalid());
    }
    let registry = app.state::<Registry>();
    let _serial = registry.mutation.lock().await;
    let worker = app.clone();
    crate::services::settings::write(&app, move |writer| {
        // Read after taking the common settings writer, so a concurrent choice
        // cannot be lost by resetting an earlier settings snapshot.
        let state = worker.state::<crate::state::AppState>();
        let mut selections = state.settings().font_selections;
        selections.without(&id);
        let mut prepared =
            writer.prepare_update(serde_json::json!({"fontSelections": selections}))?;
        let directory = repository::root(&worker).join(&id);
        let retired = repository::root(&worker).join(format!(".removed-{}", uuid::Uuid::new_v4()));
        let exists = directory.try_exists()?;
        if exists {
            std::fs::rename(&directory, &retired)?;
        }
        if let Err(error) = prepared.persist() {
            if exists {
                let _ = std::fs::rename(&retired, &directory);
            }
            return Err(error);
        }
        prepared.finish();
        let _ = worker.emit("fonts://changed", ());
        if exists {
            std::fs::remove_dir_all(retired)?;
        }
        Ok(())
    })
    .await
}
