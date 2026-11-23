//! Native proxy surface. Plugin RPCs use the experimental proxy domain.
use crate::{
    error::AppResult,
    services::proxy::{self, contract},
};
use tauri::AppHandle;

#[tauri::command]
pub fn proxy_groups_list(
    app: AppHandle,
    host_id: Option<String>,
) -> AppResult<Vec<contract::RevisionedGroup>> {
    proxy::list_groups(&app, host_id.as_deref())
}

#[tauri::command]
pub fn proxy_group_save(
    app: AppHandle,
    group: contract::ProxyGroupInput,
    expected_revision: Option<String>,
) -> AppResult<contract::RevisionedGroup> {
    proxy::save_group(&app, group, expected_revision.as_deref())
}

#[tauri::command]
pub fn proxy_group_remove(app: AppHandle, id: String, expected_revision: String) -> AppResult<()> {
    proxy::remove_group(&app, &id, &expected_revision)
}

#[tauri::command]
pub fn proxy_routes_list(
    app: AppHandle,
    group_id: Option<String>,
) -> AppResult<Vec<contract::RevisionedRoute>> {
    proxy::list_routes(&app, group_id.as_deref())
}

#[tauri::command]
pub fn proxy_route_save(
    app: AppHandle,
    route: contract::ProxyRoute,
    expected_revision: Option<String>,
) -> AppResult<contract::RevisionedRoute> {
    proxy::save_route(&app, route, expected_revision.as_deref())
}

#[tauri::command]
pub fn proxy_route_remove(app: AppHandle, id: String, expected_revision: String) -> AppResult<()> {
    proxy::remove_route(&app, &id, &expected_revision)
}

#[tauri::command]
pub fn proxy_runtime_list(app: AppHandle) -> AppResult<Vec<contract::ProxyRuntime>> {
    proxy::runtime::runtime(&app)
}

#[tauri::command]
pub async fn proxy_runtime_start(
    app: AppHandle,
    group_id: String,
    expected_revision: Option<String>,
) -> AppResult<contract::ProxyRuntime> {
    proxy::runtime::start_owned(&app, &group_id, expected_revision.as_deref(), None).await
}

#[tauri::command]
pub async fn proxy_runtime_stop(
    app: AppHandle,
    group_id: String,
    expected_revision: Option<String>,
    runtime_id: Option<String>,
) -> AppResult<()> {
    proxy::runtime::stop(
        &app,
        &group_id,
        expected_revision.as_deref(),
        runtime_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn proxy_connections_list(
    app: AppHandle,
    group_id: Option<String>,
) -> AppResult<Vec<contract::ProxyConnection>> {
    proxy::runtime::connections(&app, group_id.as_deref())
}

#[tauri::command]
pub fn proxy_connection_close(app: AppHandle, id: String) -> AppResult<()> {
    proxy::runtime::close_connection(&app, &id)
}
