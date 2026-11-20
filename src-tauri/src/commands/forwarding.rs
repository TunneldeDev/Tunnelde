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
    group_id: Option<String>,
    assign_group: Option<bool>,
) -> AppResult<ConfiguredRule> {
    let options = automation.unwrap_or_default();
    if let Some(origin) = origin {
        let entry = crate::plugins::forwarding::save(
            &app,
            &origin,
            rule,
            expected_revision.as_deref(),
            options,
            assign_group
                .filter(|assign| *assign)
                .map(|_| group_id.as_deref()),
        )?;
        return Ok(ConfiguredRule {
            entry,
            automation: options,
        });
    }
    if assign_group == Some(true) {
        let entry = forwarding::save_grouped(
            &app,
            rule,
            expected_revision.as_deref(),
            options,
            group_id.as_deref(),
        )?;
        automation::changed(&app);
        Ok(ConfiguredRule {
            entry,
            automation: options,
        })
    } else {
        automation::save(&app, rule, expected_revision.as_deref(), options)
    }
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
    match (expected_revision.as_deref(), runtime_id.as_deref()) {
        (Some(revision), runtime) => forwarding::stop_checked(&app, &id, revision, runtime).await,
        // Historical callers that supplied neither token retain their wire
        // behavior. An instance-only request must never fall back to blind stop.
        (None, None) => forwarding::stop(&app, &id).await,
        _ => Err(crate::error::AppError::validation("forward.changed")),
    }
}

#[tauri::command]
pub(crate) fn forwarding_groups_list(
    app: AppHandle,
    host_id: Option<String>,
) -> AppResult<Vec<forwarding::groups::Group>> {
    use tauri::Manager;
    app.state::<crate::state::AppState>()
        .db
        .with(|conn| forwarding::groups::list(conn, host_id.as_deref()))
}
#[tauri::command]
pub(crate) fn forwarding_group_save(
    app: AppHandle,
    host_id: String,
    name: String,
    id: Option<String>,
    expected_revision: Option<String>,
) -> AppResult<forwarding::groups::Group> {
    use tauri::Manager;
    let group = app.state::<crate::state::AppState>().db.with(|conn| {
        crate::db::atomic(conn, |conn| {
            forwarding::groups::save_at(
                conn,
                id.as_deref(),
                &host_id,
                &name,
                expected_revision.as_deref(),
            )
        })
    })?;
    automation::changed(&app);
    Ok(group)
}
#[tauri::command]
pub(crate) fn forwarding_group_remove(
    app: AppHandle,
    id: String,
    expected_revision: String,
) -> AppResult<()> {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    forwarding::groups::remove(&state.db, &state.forwards, &id, &expected_revision)?;
    automation::changed(&app);
    Ok(())
}
#[tauri::command]
pub(crate) fn forwarding_move(
    app: AppHandle,
    id: String,
    expected_revision: String,
    group_id: Option<String>,
) -> AppResult<crate::services::forwarding::contract::RevisionedRule> {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let entry = forwarding::groups::move_rule(
        &state.db,
        &state.forwards,
        &id,
        &expected_revision,
        group_id.as_deref(),
    )?;
    automation::changed(&app);
    Ok(entry)
}
#[tauri::command]
pub(crate) async fn forwarding_start_managed(
    app: AppHandle,
    id: String,
    expected_revision: String,
    request: Option<crate::ssh::SshConnectRequest>,
    review: Option<crate::ssh::session::review::Review>,
    origin: Option<Origin>,
) -> AppResult<crate::ssh::SessionInfo> {
    if let Some(origin) = origin {
        return crate::plugins::forwarding::start_managed(
            &app,
            &origin,
            &id,
            &expected_revision,
            request,
            review,
        )
        .await;
    }
    forwarding::start_managed(&app, &id, Some(&expected_revision), request, review).await
}
