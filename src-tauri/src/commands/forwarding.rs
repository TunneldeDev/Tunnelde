//! Native IPC adapter for the forwarding domain. Keep command names and wire DTOs compatible.
use crate::{
    error::AppResult,
    plugins::forwarding::Origin,
    services::forwarding::{
        self,
        automation::{self, ConfiguredInfo, ConfiguredRule, Options},
        contract::ForwardRule,
    },
};
use tauri::AppHandle;

#[tauri::command]
pub fn forwarding_list(app: AppHandle) -> AppResult<Vec<ConfiguredInfo>> {
    automation::list(&app)
}
#[tauri::command]
pub fn forwarding_save(
    app: AppHandle,
    rule: ForwardRule,
    expected_revision: Option<String>,
    origin: Option<Origin>,
    automation: Option<Options>,
) -> AppResult<ConfiguredRule> {
    let options = automation.unwrap_or_default();
    if let Some(origin) = origin {
        let entry = crate::plugins::forwarding::save(
            &app,
            &origin,
            rule,
            expected_revision.as_deref(),
            options,
        )?;
        return Ok(ConfiguredRule {
            entry,
            automation: options,
        });
    }
    automation::save(&app, rule, expected_revision.as_deref(), options)
}
#[tauri::command]
pub fn forwarding_remove(
    app: AppHandle,
    id: String,
    expected_revision: Option<String>,
    origin: Option<Origin>,
) -> AppResult<()> {
    if let Some(origin) = origin {
        return crate::plugins::forwarding::remove(
            &app,
            &origin,
            &id,
            expected_revision.as_deref(),
        );
    }
    forwarding::remove_checked(&app, &id, expected_revision.as_deref())
}
#[tauri::command]
pub async fn forwarding_start(
    app: AppHandle,
    id: String,
    session_id: String,
    expected_revision: Option<String>,
    origin: Option<Origin>,
) -> AppResult<()> {
    if let Some(origin) = origin {
        return crate::plugins::forwarding::start(
            &app,
            &origin,
            &id,
            &session_id,
            expected_revision.as_deref(),
        )
        .await;
    }
    forwarding::start_checked(&app, &id, &session_id, None, expected_revision.as_deref()).await
}
#[tauri::command]
pub async fn forwarding_stop(
    app: AppHandle,
    id: String,
    origin: Option<Origin>,
    expected_revision: Option<String>,
    runtime_id: Option<String>,
) -> AppResult<()> {
    if let Some(origin) = origin {
        return crate::plugins::forwarding::stop(
            &app,
            &origin,
            &id,
            expected_revision.as_deref(),
            runtime_id.as_deref(),
        )
        .await;
    }
    forwarding::stop(&app, &id).await
}
