use serde_json::{json, Value};
use tauri::Manager;

use super::super::{
    authorize, bootstrap, exec, field, host_id, lifecycle, model::LaunchState, repository,
    HostContext, Record,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

/// A dropped RPC still wakes cleanup. There is never an implicit retry of start.
struct RecoverOnDrop(tauri::AppHandle);
impl Drop for RecoverOnDrop {
    fn drop(&mut self) {
        lifecycle::request_recovery(&self.0);
    }
}

pub(in crate::plugins::runners) async fn start(
    context: &HostContext,
    params: Value,
    initialized: bool,
) -> AppResult<Value> {
    let (session, directory, config, initial) = if initialized {
        let request = bootstrap::Request::parse(params)?;
        let initial = request.envelope()?;
        (request.session_id, request.directory, None, initial)
    } else {
        let session: String = field(&params, "sessionId")?;
        let directory: String = field(&params, "directory")?;
        let config = serde_json::to_vec(&field::<Value>(&params, "config")?)?;
        let initial = format!(
            "{}\n",
            json!({"secrets":params.get("secrets").cloned().unwrap_or_else(||json!({}))})
        );
        if config.len() > 1024 * 1024 || initial.len() > 256 * 1024 {
            return Err(AppError::validation("plugin.runners.inputTooLarge"));
        }
        (session, directory, Some(config), initial)
    };
    let host = host_id(context, &session)?;
    let id = uuid::Uuid::new_v4().to_string();
    let state = context.app.state::<AppState>();
    let _lease = state.runners.admit(&context.id, &id)?;
    let _recover = RecoverOnDrop(context.app.clone());
    let selected = |records: &[Record]| {
        records
            .iter()
            .find(|record| {
                record.runner_id == "deployment"
                    && record.deployment_ready()
                    && record.deployment.host_id == host
                    && record.deployment.directory == directory
                    && record.deployment.fingerprint == context.fingerprint
            })
            .cloned()
            .ok_or_else(|| AppError::validation("plugin.runners.deployFirst"))
    };
    // Negotiate against the exact selected helper before reserving a task or
    // creating configuration artifacts. No fallback to the legacy writer.
    let negotiated = if initialized {
        let observed = selected(&repository::read(context)?)?;
        bootstrap::require_support(context, &session, &observed.deployment).await?;
        Some(observed)
    } else {
        None
    };
    // The reservation precedes launch and configuration mutations; discovery
    // above is read-only and never creates a task directory.
    let reserved = repository::transaction(context, |records| {
        authorize(context, &["ssh.exec"])?;
        let selected = selected(records)?;
        if negotiated
            .as_ref()
            .is_some_and(|observed| !observed.same_revision(&selected))
        {
            return Err(AppError::validation("plugin.runners.recordChanged"));
        }
        let deployment = selected.deployment;
        let record = Record {
            runner_id: id.clone(),
            deployment,
            stop_pending: true,
            runtime_owner: Some(lifecycle::Owner::current(context.generation)),
            revision: 1,
            launch_state: LaunchState::Reserved,
            controller_fingerprint: None,
            terminal_status: None,
            deployment_state: None,
            configuration_state: if initialized {
                None
            } else {
                Some(super::configuration::journal::State::Reserved)
            },
            configuration_transport: initialized
                .then_some(bootstrap::contracts::Configuration::InitializeV1),
        };
        super::super::identity::verify(
            &record.deployment,
            &super::super::identity::capture(&context.app, &session)?,
        )?;
        records.push(record.clone());
        Ok(record)
    })?;
    let (ready, transport_args) = if let Some(config) = config {
        let (ready, path) =
            super::configuration::write(context, &session, &reserved, &config).await?;
        (ready, vec!["--config".into(), path])
    } else {
        (reserved, vec!["--bootstrap".into(), "initialize-v1".into()])
    };
    let deployment = &ready.deployment;
    authorize(context, &["ssh.exec"])?;
    let mut dispatched = ready.clone();
    dispatched.launch_state = LaunchState::Unconfirmed;
    dispatched.advance()?;
    if !repository::compare_update(context, &ready, |record| {
        authorize(context, &["ssh.exec"])?;
        *record = dispatched.clone();
        Ok(())
    })? {
        return Err(AppError::validation("plugin.runners.stopPending"));
    }
    let mut args = vec![
        "start".into(),
        "--directory".into(),
        directory,
        "--id".into(),
        id.clone(),
        "--executable".into(),
        deployment.executable.clone(),
        "--entry".into(),
        deployment.entry.clone(),
    ];
    args.extend(transport_args);
    let result = exec(context, &session, deployment, args, Some(initial)).await?;
    if result["runnerId"].as_str() != Some(&id) || result["status"].as_str() != Some("starting") {
        return Err(AppError::validation("plugin.runners.invalidResponse"));
    }
    authorize(context, &["ssh.exec"])?;
    if !repository::compare_update(context, &dispatched, |record| {
        record.launch_state = LaunchState::Confirmed;
        record.stop_pending = false;
        record.advance()
    })? {
        // A newer cancellation or revocation wins over this late start response.
        return Err(AppError::validation("plugin.runners.stopPending"));
    }
    Ok(result)
}
