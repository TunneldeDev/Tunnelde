//! Native, exact-record consent. Never upgrades the original remote package.
pub(super) mod consent;
mod presentation;
#[cfg(test)]
mod tests;
mod transition;
use super::{authorize, field, identity, repository, HostContext, Record};
use crate::{
    error::{AppError, AppResult},
    plugins::security::Lease,
    state::AppState,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Kind {
    Destination,
    Control,
}

pub(super) async fn request(
    context: &HostContext,
    session: &str,
    observed: &Record,
    kind: Kind,
    plugin_authority: bool,
) -> AppResult<bool> {
    let actual = identity::capture(&context.app, session)?;
    transition::validate(observed, kind, &actual, &context.fingerprint)?;
    let state = context.app.state::<AppState>();
    let key = if observed.runner_id == "deployment" {
        format!(
            "deploy:{}:{}",
            observed.deployment.host_id, observed.deployment.directory
        )
    } else {
        observed.runner_id.clone()
    };
    let _lease = state.runners.admit(&context.id, &key)?;
    let decision = consent::ask(
        &context.app,
        &context.id,
        observed,
        &actual,
        kind,
        &context.fingerprint,
    );
    let approved = if plugin_authority {
        authorize(context, &["ssh.exec"])?;
        state
            .plugins
            .security
            .guard(
                &Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                },
                decision,
            )
            .await?
    } else {
        decision.await?
    };
    if !approved {
        return Ok(false);
    }
    if identity::capture(&context.app, session)? != actual {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    if !repository::compare_update(context, observed, |record| {
        if plugin_authority {
            authorize(context, &["ssh.exec"])?;
        }
        transition::apply(
            record,
            kind,
            actual,
            &context.fingerprint,
            context.generation,
        )
    })? {
        return Err(AppError::validation("plugin.runners.recordChanged"));
    }
    super::lifecycle::request_recovery(&context.app);
    crate::logs::record(
        &state.db,
        match kind {
            Kind::Destination => "runners.bind",
            Kind::Control => "runners.handoff",
        },
        Some(&context.id),
    );
    Ok(true)
}

pub(super) async fn dispatch(context: &HostContext, params: Value) -> AppResult<Value> {
    let session: String = field(&params, "sessionId")?;
    let runner: String = field(&params, "runnerId")?;
    let directory: String = field(&params, "directory")?;
    let kind: Kind = field(&params, "kind")?;
    let actual = identity::capture(&context.app, &session)?;
    let records = repository::read(context)?;
    let mut matches = records.iter().filter(|record| {
        record.runner_id == runner
            && record.deployment.directory == directory
            && record.deployment.host_id == actual.host_id
    });
    let observed = matches
        .next()
        .ok_or_else(|| AppError::validation("plugin.runners.notFound"))?;
    if matches.next().is_some() {
        return Err(AppError::validation("plugin.runners.invalidMetadata"));
    }
    Ok(serde_json::json!({"reviewed":request(context,&session,observed,kind,true).await?}))
}
