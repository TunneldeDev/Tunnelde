//! Native-only observation; leases and exact-record/target checks span both reads.
use super::{contracts::Outcome, query};
use crate::{
    error::AppResult,
    plugins::runners::{artifacts, identity, HostContext, Record},
    state::AppState,
};
use tauri::Manager;

pub(super) async fn inspect(
    context: &HostContext,
    session: &str,
    record: &Record,
    token: &str,
) -> AppResult<Outcome> {
    let state = context.app.state::<AppState>();
    let _lease = state.runners.admit(&context.id, &record.runner_id)?;
    let check = || {
        query::selected(context, token)?;
        identity::verify(
            &record.deployment,
            &identity::capture(&context.app, session)?,
        )
    };
    let result = artifacts::observe(context, session, record, check).await?;
    Ok(Outcome {
        accepted: true,
        artifacts: Some(artifacts::contracts::Observation {
            token: token.into(),
            checked_at: crate::models::now_ms(),
            result,
        }),
        ..Outcome::default()
    })
}
