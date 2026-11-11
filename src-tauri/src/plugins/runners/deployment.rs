//! Confirm and prepare first; persist each deployment phase before remote mutation.
use super::{
    authorize, field, frontend_request, host_id, path_join, repository, validate_directory,
    Deployment, HostContext,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

pub(super) mod journal;
mod package;
mod upload;

pub(super) async fn deploy(context: &HostContext, params: Value) -> AppResult<Value> {
    authorize(context, &["fs.read", "sftp.write"])?;
    let session: String = field(&params, "sessionId")?;
    let host = host_id(context, &session)?;
    let destination = super::identity::capture(&context.app, &session)?;
    let directory: String = field(&params, "directory")?;
    let platform: String = field(&params, "platform")?;
    if !matches!(platform.as_str(), "windows" | "posix") {
        return Err(AppError::validation("plugin.tasks.invalidPlatform"));
    }
    validate_directory(&directory, &platform)?;
    let executable: String = field(&params, "executable")?;
    let records = repository::read(context)?;
    if let Some(existing) = records.iter().find(|record| {
        record.runner_id == "deployment"
            && record.deployment.host_id == host
            && record.deployment.directory == directory
    }) {
        super::identity::verify(&existing.deployment, &destination)?;
        if !existing.deployment_ready() {
            return Err(AppError::validation("plugin.runners.deploymentIncomplete"));
        }
        let deployed = &existing.deployment;
        if deployed.fingerprint == context.fingerprint
            && deployed.platform == platform
            && deployed.executable == executable
        {
            return Ok(json!({"deployed":true,"reused":true,"directory":directory}));
        }
        return Err(AppError::validation(
            "plugin.runners.freshDirectoryRequired",
        ));
    }
    if records.len() >= repository::MAX_RECORDS {
        return Err(AppError::validation("plugin.runners.tooManyTasks"));
    }
    let runner_path = PathBuf::from(field::<String>(&params, "runnerPath")?);
    if !runner_path.is_absolute() {
        return Err(AppError::validation(
            "plugin.runners.explicitBinaryRequired",
        ));
    }
    let approved=frontend_request(context,"ui.confirm",json!({"message":format!("Deploy an agent runner to SSH host {host}?\nDirectory: {directory}\nSelected runtime: {executable}\nThis executes the selected runtime on that host. Background tasks can continue after Tunnelde closes. No system service will be changed.")})).await?;
    if approved.as_bool() != Some(true) {
        return Err(AppError::validation("plugin.tools.denied"));
    }
    authorize(context, &["ssh.exec", "fs.read", "sftp.write"])?;
    let state = context.app.state::<AppState>();
    let lease = state
        .runners
        .admit(&context.id, &format!("deploy:{host}:{directory}"))?;
    // Snapshot the bounded approved package and open the selected helper before
    // any remote mutation. Preparation failures leave no remote residue.
    let plugin = state
        .plugins
        .list()
        .await
        .into_iter()
        .find(|plugin| plugin.id == context.id)
        .ok_or_else(|| AppError::validation("plugin.notFound"))?;
    let fingerprint = context.fingerprint.clone();
    let target_platform = platform.clone();
    let (package, _lease) = tokio::task::spawn_blocking(move || {
        let package =
            package::Package::capture(&PathBuf::from(plugin.path), &fingerprint, &target_platform);
        // A dropped caller cannot free capacity while its blocking snapshot is
        // still reading and retaining package bytes.
        (package, lease)
    })
    .await
    .map_err(|_| AppError::internal("plugin.runners.preparationFailed"))?;
    let package = package?;
    let helper = upload::helper(&runner_path).await?;
    authorize(context, &["ssh.exec", "fs.read", "sftp.write"])?;
    if super::identity::capture(&context.app, &session)? != destination {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    let sftp = crate::ssh::files::session(&context.app, &session).await?;
    match sftp.symlink_metadata(&directory).await {
        Ok(_) => {
            return Err(AppError::validation(
                "plugin.runners.freshDirectoryRequired",
            ))
        }
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => {}
        Err(error) => return Err(AppError::Ssh(error.to_string())),
    }
    let deployment = Deployment {
        host_id: host,
        directory: directory.clone(),
        platform: platform.clone(),
        executable,
        runner: path_join(
            &directory,
            if platform == "windows" {
                "tunnelde-agent.exe"
            } else {
                "tunnelde-agent"
            },
            &platform,
        ),
        entry: path_join(&directory, "remote-entry.mjs", &platform),
        fingerprint: context.fingerprint.clone(),
        identity: Some(destination.clone()),
    };
    let reserved = journal::reserve(context, deployment)?;
    // A lost MKDIR response stays Creating: existence alone cannot prove that
    // our request finished, or that an existing directory belongs to it.
    let creating = journal::advance(context, &reserved, journal::State::Creating)?;
    authorize(context, &["ssh.exec", "sftp.write"])?;
    sftp.create_dir(&directory)
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let uploading = journal::advance(context, &creating, journal::State::Uploading)?;
    upload::execute(context, &sftp, &uploading.deployment, helper, package).await?;
    authorize(context, &["ssh.exec", "fs.read", "sftp.write"])?;
    if super::identity::capture(&context.app, &session)? != destination {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    journal::advance(context, &uploading, journal::State::Ready)?;
    Ok(json!({"deployed":true,"directory":directory}))
}
