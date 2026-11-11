//! Native observation only. Never saves capabilities as authority or settles tasks.
use super::{contracts::Outcome, query};
use crate::{
    error::{AppError, AppResult},
    plugins::runners::{capabilities, identity, HostContext, Record},
    state::AppState,
};
use tauri::Manager;

pub(super) async fn inspect(
    context: &HostContext,
    session: &str,
    record: &Record,
    token: &str,
) -> AppResult<Outcome> {
    if !record.deployment_ready() {
        return Err(AppError::validation("plugin.runners.controlUnavailable"));
    }
    let state = context.app.state::<AppState>();
    let _lease = state.runners.admit(&context.id, &record.runner_id)?;
    query::selected(context, token)?;
    let result = capabilities::observe(context, session, &record.deployment).await;
    // Discard observations after a concurrent stop, handoff, removal or replacement.
    query::selected(context, token)?;
    identity::verify(
        &record.deployment,
        &identity::capture(&context.app, session)?,
    )?;
    Ok(Outcome {
        accepted: true,
        capabilities: Some(capabilities::contracts::Observation {
            token: token.into(),
            checked_at: crate::models::now_ms(),
            result,
        }),
        ..Outcome::default()
    })
}
