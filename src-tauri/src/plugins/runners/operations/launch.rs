use serde_json::{json, Value};
use tauri::Manager;

use super::super::{
    authorize, exec, field, host_id, lifecycle, model::LaunchState, repository, HostContext, Record,
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
) -> AppResult<Value> {
    let session: String = field(&params, "sessionId")?;
    let host = host_id(context, &session)?;
    let directory: String = field(&params, "directory")?;
    let config: Value = field(&params, "config")?;
    let config = serde_json::to_vec(&config)?;
    let initial = format!(
        "{}\n",
        json!({"secrets": params.get("secrets").cloned().unwrap_or_else(|| json!({}))})
    );
    if config.len() > 1024 * 1024 || initial.len() > 256 * 1024 {
        return Err(AppError::validation("plugin.runners.inputTooLarge"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let state = context.app.state::<AppState>();
    let _lease = state.runners.admit(&context.id, &id)?;
    let _recover = RecoverOnDrop(context.app.clone());
    // The reservation precedes every remote side effect, including config creation.
    let reserved = repository::transaction(context, |records| {
        authorize(context, &["ssh.exec"])?;
        let deployment = records
            .iter()
            .find(|record| {
                record.runner_id == "deployment"
                    && record.deployment_ready()
                    && record.deployment.host_id == host
                    && record.deployment.directory == directory
                    && record.deployment.fingerprint == context.fingerprint
            })
            .map(|record| record.deployment.clone())
            .ok_or_else(|| AppError::validation("plugin.runners.deployFirst"))?;
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
            configuration_state: Some(super::configuration::journal::State::Reserved),
        };
        super::super::identity::verify(
            &record.deployment,
            &super::super::identity::capture(&context.app, &session)?,
        )?;
        records.push(record.clone());
        Ok(record)
    })?;
    let (ready, config_path) =
        super::configuration::write(context, &session, &reserved, &config).await?;
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
    let result = exec(
        context,
        &session,
        deployment,
        vec![
            "start".into(),
            "--directory".into(),
            directory,
            "--id".into(),
            id.clone(),
            "--config".into(),
            config_path,
            "--executable".into(),
            deployment.executable.clone(),
            "--entry".into(),
            deployment.entry.clone(),
        ],
        Some(initial),
    )
    .await?;
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
