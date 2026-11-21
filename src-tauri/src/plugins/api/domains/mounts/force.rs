//! The host, not a plugin's ui.confirm parameters, owns destructive consent.
use super::{lease, HostContext};
use crate::{
    error::AppResult,
    plugins::api::{field, transport::frontend::frontend_request_with_permissions},
    services::mounts::runtime::{self, force::Target, Authority},
    state::AppState,
};
use serde_json::{json, Value};
use tauri::Manager;

pub(super) async fn call(context: &HostContext, params: Value) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    let target = Target::capture(
        &state.mount_runtime.rule_states(),
        &field::<String>(&params, "id")?,
        &field::<String>(&params, "runtimeId")?,
    )?;
    let confirmed = frontend_request_with_permissions(
        context,
        "__mounts.forceUnmount",
        json!({
            "message": if state.locale().starts_with("zh") {
                "强制卸载可能丢失尚未写入的文件内容。是否继续？"
            } else { "Force unmount may discard pending file writes. Continue?" }
        }),
        &["mounts.write"],
    )
    .await?;
    if confirmed != Value::Bool(true) {
        return Ok(json!({"confirmed": false}));
    }
    let gate = state.mount_runtime.gate(&target.group)?;
    let authority = Authority(Some(lease(context)));
    authority.check(app)?;
    target.recheck(&state.mount_runtime.rule_states())?;
    state
        .mounts
        .unmount_checked(
            runtime::OWNER,
            &target.runtime,
            true,
            Some(0),
            runtime::force::policy(app, authority, target.clone(), gate),
        )
        .await?;
    Ok(json!({"confirmed": true}))
}
