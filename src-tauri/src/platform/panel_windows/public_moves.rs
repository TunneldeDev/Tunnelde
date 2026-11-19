use super::{native, ownership::Ownership, protocol::Command};
use crate::{
    error::{AppError, AppResult},
    plugins::security::Lease as PluginLease,
    state::AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MoveRequest {
    panel_id: String,
    window_id: String,
    expected_owner: Option<ExpectedOwner>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedOwner {
    window_id: String,
    generation: u64,
}
fn policy(app: &AppHandle, owner: &PluginLease) -> Result<(), &'static str> {
    app.state::<AppState>()
        .plugins
        .security
        .authorize(
            &owner.id,
            &owner.fingerprint,
            &owner.permissions,
            Some("workspace.write"),
            Some(owner.generation),
        )
        .map(|_| ())
        .map_err(|_| "pluginSecurity.changed")
}

struct MoveWait {
    app: AppHandle,
    id: String,
}
impl Drop for MoveWait {
    fn drop(&mut self) {
        let cancelled = native::lock(&self.app.state::<native::Registry>())
            .cancel_move(&self.id, "panel.window.cancelled");
        if cancelled {
            native::changed(&self.app);
        }
    }
}
pub(super) async fn request(
    app: &AppHandle,
    owner: PluginLease,
    request: MoveRequest,
) -> AppResult<Value> {
    let valid = |value: &str, max| !value.is_empty() && value.len() <= max && !value.contains('\0');
    if !valid(&request.panel_id, 256)
        || !valid(&request.window_id, 128)
        || request
            .expected_owner
            .as_ref()
            .is_some_and(|o| !valid(&o.window_id, 128))
    {
        return Err(AppError::validation("plugin.api.invalid:move"));
    }
    policy(app, &owner).map_err(native::invalid)?;
    let (id, receiver) = native::lock(&app.state::<native::Registry>())
        .submit_move(
            owner,
            &request.panel_id,
            &request.window_id,
            request
                .expected_owner
                .as_ref()
                .map(|o| (o.window_id.as_str(), o.generation)),
            Instant::now(),
        )
        .map_err(native::invalid)?;
    let _wait = MoveWait {
        app: app.clone(),
        id,
    };
    native::changed(app);
    let lease = tokio::time::timeout(Duration::from_secs(26), receiver)
        .await
        .map_err(|_| native::invalid("panel.window.timeout"))?
        .map_err(|_| native::invalid("panel.window.cancelled"))?
        .map_err(native::invalid)?;
    Ok(json!(lease))
}

/// Called ONLY while holding native ownership. Policy and handoff admission
/// therefore cannot be separated by a source reload or competing panel move.
pub(super) fn control(
    app: &AppHandle,
    ownership: &mut Ownership,
    window: &str,
    document: &str,
    request: Command,
    now: Instant,
) -> AppResult<Value> {
    match request {
        Command::ClaimPanelMoves {} => Ok(json!(ownership
            .claim_moves(window, document, now, |o| policy(app, o))
            .map_err(native::invalid)?)),
        Command::PreparePanelMove { id, state } => Ok(json!(ownership
            .prepare_move(window, document, &id, state, now, |o| policy(app, o))
            .map_err(native::invalid)?)),
        Command::FailPanelMove { id } => {
            ownership
                .fail_move(window, document, &id)
                .map_err(native::invalid)?;
            Ok(Value::Null)
        }
        Command::Commit { id } => {
            ownership
                .authorize(window, document)
                .map_err(native::invalid)?;
            // Only main may commit; an unrelated document cannot revoke a
            // legitimate job by guessing its transfer ID and failing policy.
            ownership.main(window, document).map_err(native::invalid)?;
            if let Some(owner) = ownership.move_owner_for_offer(&id) {
                // Final metadata commit linearizes WITH policy revocation, not
                // merely a check followed by an independently mutable policy.
                // Order: native ownership -> policy -> invocation; cleanup releases policy
                // before touching native windows. No I/O or await in this gate.
                let invocation = ownership.move_invocation_for_offer(&id);
                let result = app.state::<AppState>().plugins.security.with_authorized(
                    &owner,
                    &["workspace.write"],
                    || {
                        let mut commit = || {
                            ownership
                                .authorize_move_commit(&id, now, |_| Ok(()))
                                .map_err(native::invalid)?;
                            ownership
                                .dispatch(window, document, Command::Commit { id: id.clone() }, now)
                                .map_err(native::invalid)
                        };
                        match invocation {
                            Some(ref invocation) => invocation.with_live(commit),
                            None => commit(),
                        }
                    },
                );
                if result.is_err() {
                    ownership.cancel_move_offer(&id);
                }
                result
            } else {
                ownership
                    .dispatch(window, document, Command::Commit { id }, now)
                    .map_err(native::invalid)
            }
        }
        request => ownership
            .dispatch(window, document, request, now)
            .map_err(native::invalid),
    }
}
