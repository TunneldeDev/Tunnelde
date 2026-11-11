use super::{
    super::{identity, repository, review, HostContext, Record},
    contracts::*,
    mutation, query,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use tauri::{AppHandle, Manager};

async fn controller(app: &AppHandle, id: &str) -> AppResult<HostContext> {
    let state = app.state::<AppState>();
    let plugin = state
        .plugins
        .list()
        .await
        .into_iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| AppError::validation("plugin.notFound"))?;
    let generation = state.plugins.security.authorize(
        id,
        &plugin.fingerprint,
        &plugin.permissions,
        Some("ssh.exec"),
        None,
    )?;
    Ok(HostContext {
        app: app.clone(),
        id: id.into(),
        fingerprint: plugin.fingerprint,
        permissions: plugin.permissions,
        generation,
        tool_client: None,
        tool_request: None,
    })
}

fn still_selected(context: &HostContext, record: &Record) -> AppResult<()> {
    query::selected(context, &query::token(record)?).map(|_| ())
}

pub(super) async fn execute(app: &AppHandle, request: Request) -> AppResult<Outcome> {
    let mut context = query::context(app, &request.plugin_id)?;
    let observed = query::selected(&context, &request.token)?;
    let state = app.state::<AppState>();
    if matches!(request.action, Action::Stop | Action::Forget) {
        mutation::validate(&observed, request.action)?;
        let approved = if matches!(request.action, Action::Stop) {
            review::consent::stop(app, &context.id, &observed).await?
        } else {
            review::consent::forget(app, &context.id, &observed).await?
        };
        if !approved {
            return Ok(Outcome::default());
        }
        repository::transaction(&context, |records| {
            mutation::apply(records, &request.token, request.action)
        })?;
        super::super::lifecycle::request_recovery(app);
        crate::logs::record(
            &state.db,
            if matches!(request.action, Action::Stop) {
                "runners.stopRequested"
            } else {
                "runners.forget"
            },
            Some(&context.id),
        );
        return Ok(Outcome {
            accepted: true,
            ..Outcome::default()
        });
    }
    let session = identity::select(
        &observed,
        &identity::sessions(app),
        matches!(request.action, Action::ReviewDestination),
    )?;
    if matches!(request.action, Action::Capabilities) {
        return super::capabilities::inspect(&context, &session, &observed, &request.token).await;
    }
    if matches!(request.action, Action::ReviewDestination | Action::Handoff) {
        let control = matches!(request.action, Action::Handoff);
        if control {
            context = controller(app, &context.id).await?;
        }
        still_selected(&context, &observed)?;
        let approved = review::request(
            &context,
            &session,
            &observed,
            if control {
                review::Kind::Control
            } else {
                review::Kind::Destination
            },
            control,
        )
        .await?;
        return Ok(Outcome {
            accepted: approved,
            ..Outcome::default()
        });
    }
    if observed.runner_id == "deployment" {
        return Err(AppError::validation("plugin.runners.controlUnavailable"));
    }
    let _lease = state.runners.admit(&context.id, &observed.runner_id)?;
    still_selected(&context, &observed)?;
    let result = super::super::exec(
        &context,
        &session,
        &observed.deployment,
        vec![
            "status".into(),
            "--directory".into(),
            observed.deployment.directory.clone(),
            "--id".into(),
            observed.runner_id.clone(),
        ],
        None,
    )
    .await?;
    let status = result["status"]
        .as_str()
        .filter(|status| {
            matches!(
                *status,
                "starting"
                    | "running"
                    | "stopping"
                    | "stopped"
                    | "failed"
                    | "notFound"
                    | "unresponsive"
            )
        })
        .ok_or_else(|| AppError::validation("plugin.runners.invalidResponse"))?;
    let mut settled = observed.clone();
    if !repository::compare_update(&context, &observed, |record| {
        record.settle(status)?;
        settled = record.clone();
        Ok(())
    })? {
        return Err(AppError::validation("plugin.runners.recordChanged"));
    }
    Ok(Outcome {
        accepted: true,
        observation: Some(Observation {
            token: query::token(&settled)?,
            status: status.into(),
            error: result["error"].as_str().map(|text| {
                text.chars()
                    .filter(|character| !character.is_control())
                    .take(512)
                    .collect()
            }),
            checked_at: crate::models::now_ms(),
        }),
        ..Outcome::default()
    })
}
