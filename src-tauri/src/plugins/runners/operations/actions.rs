use serde_json::{json, Value};
use tauri::Manager;

use super::super::{
    admission, authorize, exec, field, host_id, lifecycle, optional, repository, HostContext,
    Record,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub(in crate::plugins::runners) async fn action(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if !matches!(
        method,
        "runners.stop" | "runners.send" | "runners.status" | "runners.poll"
    ) {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let session: String = field(&params, "sessionId")?;
    let id: String = field(&params, "runnerId")?;
    let host = host_id(context, &session);
    let observed = repository::read(context)?
        .into_iter()
        .find(|record| record.runner_id != "deployment" && record.runner_id == id)
        .ok_or_else(|| AppError::validation("plugin.runners.notFound"))?;
    if host.is_ok() {
        super::super::identity::verify(
            &observed.deployment,
            &super::super::identity::capture(&context.app, &session)?,
        )?;
    }
    // A disconnected session cannot prevent recording the user's stop intent.
    if host
        .as_ref()
        .is_ok_and(|host| host != &observed.deployment.host_id)
    {
        return Err(AppError::validation("plugin.runners.notFound"));
    }
    if method == "runners.stop" {
        let stopping = repository::transaction(context, |records| {
            authorize(context, &["ssh.exec"])?;
            let record = records
                .iter_mut()
                .find(|record| record.runner_id == id)
                .ok_or_else(|| AppError::validation("plugin.runners.notFound"))?;
            record.stop_pending = true;
            record.advance()?;
            Ok(record.clone())
        })?;
        lifecycle::request_recovery(&context.app);
        let state = context.app.state::<AppState>();
        let lease = state.runners.admit(&context.id, &id);
        if host.is_err() || lease.is_err() {
            return Ok(json!({"runnerId":id,"stopRequested":true,"status":"stopping"}));
        }
        let _lease = lease?;
        return stop_record(context, &session, &stopping).await;
    }
    host?;
    super::super::identity::controller(&observed, &context.fingerprint)?;
    if method == "runners.send" && observed.stop_pending {
        lifecycle::request_recovery(&context.app);
        return Err(AppError::validation("plugin.runners.stopPending"));
    }
    let state = context.app.state::<AppState>();
    let _lease = state.runners.admit(&context.id, &id)?;
    if method == "runners.status" && observed.admission.is_some() {
        let receipt =
            admission::request(context, &session, &observed, admission::Operation::Status).await?;
        authorize(context, &["ssh.exec"])?;
        if !repository::compare_update(context, &observed, |record| receipt.settle(record))? {
            return Err(AppError::validation("plugin.runners.recordChanged"));
        }
        return Ok(json!({"status":receipt.status()}));
    }
    let deployment = &observed.deployment;
    let mut args = vec![
        method.trim_start_matches("runners.").into(),
        "--directory".into(),
        deployment.directory.clone(),
        "--id".into(),
        id,
    ];
    let input = if method == "runners.send" {
        let message = format!("{}\n", field::<Value>(&params, "message")?);
        if message.len() > 256 * 1024 {
            return Err(AppError::validation("plugin.runners.inputTooLarge"));
        }
        Some(message)
    } else {
        None
    };
    if method == "runners.poll" {
        args.extend([
            "--after".into(),
            optional::<u64>(&params, "afterSeq")?
                .unwrap_or(0)
                .to_string(),
        ]);
    }
    authorize(context, &["ssh.exec"])?;
    let result = exec(context, &session, deployment, args, input).await?;
    let status = if method == "runners.poll" {
        result["state"]["status"].as_str()
    } else if method == "runners.status" {
        result["status"].as_str()
    } else {
        None
    };
    if let Some(status) = status {
        repository::compare_update(context, &observed, |record| record.settle(status))?;
    }
    if observed.stop_pending {
        lifecycle::request_recovery(&context.app);
    }
    Ok(result)
}

pub(in crate::plugins::runners) async fn stop_record(
    context: &HostContext,
    session: &str,
    record: &Record,
) -> AppResult<Value> {
    if record.admission.is_some() {
        let stopped =
            admission::request(context, session, record, admission::Operation::Stop).await;
        // A lost STOP acknowledgement can still leave a persisted fence. Only a
        // separately validated receipt can settle it; never fall back to status.
        let receipt =
            admission::request(context, session, record, admission::Operation::Status).await?;
        if !repository::compare_update(context, record, |current| receipt.settle(current))? {
            return Err(AppError::validation("plugin.runners.recordChanged"));
        }
        return stopped.map(
            |_| json!({"runnerId":record.runner_id,"stopRequested":true,"status":receipt.status()}),
        );
    }
    let deployment = &record.deployment;
    let args = |operation: &str| {
        vec![
            operation.into(),
            "--directory".into(),
            deployment.directory.clone(),
            "--id".into(),
            record.runner_id.clone(),
        ]
    };
    let stopped = exec(context, session, deployment, args("stop"), None).await;
    // Even a failed stop response may have delivered STOP. Query independently.
    let status = exec(context, session, deployment, args("status"), None).await?;
    if let Some(status) = status["status"].as_str() {
        repository::compare_update(context, record, |record| record.settle(status))?;
        if status == "notFound"
            && record.launch_state == super::super::model::LaunchState::Unconfirmed
        {
            tracing::debug!(plugin_id = %context.id, runner_id = %record.runner_id,
                action = "retain_stop_and_retry", "runner launch remains unconfirmed");
        }
    }
    stopped
}
