use crate::{
    error::{AppError, AppResult},
    services::plugin_configuration::{
        contracts::{
            document::{Backup, BackupRequest, Expected, Snapshot, Update},
            schema::Declaration,
        },
        repository::Repository,
        service,
    },
    state::AppState,
};
use tauri::{AppHandle, Manager};

async fn with_schema<T: Send + 'static>(
    app: AppHandle,
    id: String,
    fingerprint: String,
    operation: impl FnOnce(&Repository, &str, &Declaration) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    // Database contention is bounded and never blocks the WebView event thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let repo = Repository::at(
            state
                .storage
                .dir(crate::storage::layout::Category::PluginData),
        );
        state
            .plugins
            .with_configuration(&id, &fingerprint, |schema| operation(&repo, &id, schema))
    })
    .await
    .map_err(|_| AppError::internal("configuration.workerFailed"))?
}

/// Inert manifest editing works without starting or approving executable plugin code.
#[tauri::command]
pub async fn plugin_configuration_get(
    app: AppHandle,
    plugin_id: String,
    fingerprint: String,
) -> AppResult<Snapshot> {
    with_schema(app, plugin_id, fingerprint, service::read).await
}
#[tauri::command]
pub async fn plugin_configuration_update(
    app: AppHandle,
    plugin_id: String,
    fingerprint: String,
    update: Update,
) -> AppResult<Snapshot> {
    let result = with_schema(
        app.clone(),
        plugin_id.clone(),
        fingerprint,
        move |repo, id, schema| service::update(repo, id, schema, update),
    )
    .await?;
    super::events::changed(&app, &plugin_id, "update", &result);
    Ok(result)
}
#[tauri::command]
pub async fn plugin_configuration_migrate(
    app: AppHandle,
    plugin_id: String,
    fingerprint: String,
    expected: Expected,
) -> AppResult<Snapshot> {
    let result = with_schema(
        app.clone(),
        plugin_id.clone(),
        fingerprint,
        move |repo, id, schema| service::migrate(repo, id, schema, expected),
    )
    .await?;
    super::events::changed(&app, &plugin_id, "migrate", &result);
    Ok(result)
}
#[tauri::command]
pub async fn plugin_configuration_backups(
    app: AppHandle,
    plugin_id: String,
    fingerprint: String,
) -> AppResult<Vec<Backup>> {
    with_schema(app, plugin_id, fingerprint, |repo, id, _| {
        service::list_backups(repo, id)
    })
    .await
}
#[tauri::command]
pub async fn plugin_configuration_restore(
    app: AppHandle,
    plugin_id: String,
    fingerprint: String,
    request: BackupRequest,
) -> AppResult<Snapshot> {
    let result = with_schema(
        app.clone(),
        plugin_id.clone(),
        fingerprint,
        move |repo, id, schema| service::restore(repo, id, schema, request),
    )
    .await?;
    super::events::changed(&app, &plugin_id, "restore", &result);
    Ok(result)
}
#[tauri::command]
pub async fn plugin_configuration_delete_backup(
    app: AppHandle,
    plugin_id: String,
    fingerprint: String,
    request: BackupRequest,
) -> AppResult<()> {
    let snapshot = with_schema(
        app.clone(),
        plugin_id.clone(),
        fingerprint,
        move |repo, id, schema| service::delete_backup(repo, id, schema, request),
    )
    .await?;
    super::events::changed(&app, &plugin_id, "deleteBackup", &snapshot);
    Ok(())
}
