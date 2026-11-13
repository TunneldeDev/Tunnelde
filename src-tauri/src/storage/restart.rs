//! Window restart notices need plan identity, never an expensive inventory scan.
use super::{config, AppHandle, AppResult, AppState, Manager};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    id: String,
    action: config::Action,
    restart_requested: bool,
}

impl From<&config::Pending> for Plan {
    fn from(pending: &config::Pending) -> Self {
        Self {
            id: pending.id.clone(),
            action: pending.action,
            restart_requested: pending.restart_requested,
        }
    }
}

#[tauri::command]
pub async fn storage_restart_plan(app: AppHandle) -> AppResult<Option<Plan>> {
    let home = app.state::<AppState>().storage.home.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(config::load(&home)?.pending.as_ref().map(Plan::from))
    })
    .await
    .map_err(|error| crate::error::AppError::internal(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restart_notice_identifies_plan_and_recovery_intent_without_paths_or_inventory() {
        let mut pending = config::Pending {
            id: "original-plan".into(),
            action: config::Action::Apply,
            restart_requested: false,
            changes: vec![config::Change {
                category: super::super::layout::Category::Database,
                target: "/private/location".into(),
                migrate: true,
            }],
        };
        assert_eq!(
            serde_json::to_value(Plan::from(&pending)).unwrap(),
            json!({"id":"original-plan","action":"apply","restartRequested":false})
        );
        pending.action = config::Action::Cancel;
        pending.restart_requested = true;
        assert_eq!(
            serde_json::to_value(Plan::from(&pending)).unwrap(),
            json!({"id":"original-plan","action":"cancel","restartRequested":true})
        );
    }
}
