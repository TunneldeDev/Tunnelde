//! Explicit native confirmation and fresh-directory deployment.
use super::{
    authorize, field, frontend_request, host_id, model::LaunchState, path_join, repository,
    validate_directory, Deployment, HostContext, Record,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn deploy(context: &HostContext, params: Value) -> AppResult<Value> {
    authorize(context, &["fs.read", "sftp.write"])?;
    if repository::read(context)?.len() >= 256 {
        return Err(AppError::validation("plugin.runners.tooManyTasks"));
    }
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
        let deployed = &existing.deployment;
        super::identity::verify(deployed, &destination)?;
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
    let runner_path: String = field(&params, "runnerPath")?;
    let runner_path = PathBuf::from(runner_path);
    if !runner_path.is_absolute() || !runner_path.is_file() {
        return Err(AppError::validation(
            "plugin.runners.explicitBinaryRequired",
        ));
    }
    let approved=frontend_request(context,"ui.confirm",json!({"message":format!("Deploy an agent runner to SSH host {host}?\nDirectory: {directory}\nSelected runtime: {executable}\nThis executes the selected runtime on that host. Background tasks can continue after Tunnelde closes. No system service will be changed.")})).await?;
    if approved.as_bool() != Some(true) {
        return Err(AppError::validation("plugin.tools.denied"));
    }
    authorize(context, &["ssh.exec", "fs.read", "sftp.write"])?;
    if super::identity::capture(&context.app, &session)? != destination {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    let state = context.app.state::<AppState>();
    let _lease = state
        .runners
        .admit(&context.id, &format!("deploy:{host}:{directory}"))?;
    // Another confirmed request may have deployed while this confirmation was open.
    if repository::read(context)?.iter().any(|record| {
        record.runner_id == "deployment"
            && record.deployment.host_id == host
            && record.deployment.directory == directory
    }) {
        return Err(AppError::validation(
            "plugin.runners.freshDirectoryRequired",
        ));
    }
    let sftp = crate::ssh::files::session(&context.app, &session).await?;
    // Installation is deliberately confined to a fresh directory. Never overwrite existing remote content.
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
    sftp.create_dir(&directory)
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    if platform != "windows" {
        sftp.set_metadata(
            &directory,
            russh_sftp::protocol::FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    }
    let runner = path_join(
        &directory,
        if platform == "windows" {
            "tunnelde-agent.exe"
        } else {
            "tunnelde-agent"
        },
        &platform,
    );
    let mut input = tokio::fs::File::open(runner_path).await?;
    if input.metadata().await?.len() > 64 * 1024 * 1024 {
        return Err(AppError::validation("plugin.runners.binaryTooLarge"));
    }
    let mut output = sftp
        .create(&runner)
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let size = input.read(&mut chunk).await?;
        if size == 0 {
            break;
        }
        authorize(context, &["sftp.write"])?;
        output.write_all(&chunk[..size]).await?;
    }
    output.shutdown().await?;
    if platform != "windows" {
        sftp.set_metadata(
            &runner,
            russh_sftp::protocol::FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    }
    let plugin = context
        .app
        .state::<AppState>()
        .plugins
        .list()
        .await
        .into_iter()
        .find(|plugin| plugin.id == context.id)
        .ok_or_else(|| AppError::validation("plugin.notFound"))?;
    upload_directory(
        context,
        &sftp,
        &PathBuf::from(plugin.path),
        &directory,
        &platform,
    )
    .await?;
    let deployment = Deployment {
        host_id: host,
        directory: directory.clone(),
        platform: platform.clone(),
        executable,
        runner,
        entry: path_join(&directory, "remote-entry.mjs", &platform),
        fingerprint: context.fingerprint.clone(),
        identity: Some(destination),
    };
    repository::transaction(context, |records| {
        authorize(context, &["ssh.exec", "fs.read", "sftp.write"])?;
        records.push(Record {
            runner_id: "deployment".into(),
            runtime_owner: None,
            deployment,
            stop_pending: false,
            revision: 1,
            launch_state: LaunchState::Confirmed,
            controller_fingerprint: None,
            terminal_status: None,
        });
        Ok(())
    })?;
    Ok(json!({"deployed":true,"directory":directory}))
}

async fn upload_directory(
    context: &HostContext,
    sftp: &russh_sftp::client::SftpSession,
    root: &std::path::Path,
    remote: &str,
    platform: &str,
) -> AppResult<()> {
    let mut pending = vec![(root.to_path_buf(), remote.to_owned())];
    let mut count = 0;
    let mut bytes = 0;
    while let Some((local, remote)) = pending.pop() {
        for entry in std::fs::read_dir(local)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "tests") {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(AppError::validation("plugin.runners.symlinkInPackage"));
            }
            let target = path_join(&remote, &name, platform);
            if kind.is_dir() {
                sftp.create_dir(&target)
                    .await
                    .map_err(|error| AppError::Ssh(error.to_string()))?;
                pending.push((entry.path(), target));
            } else if kind.is_file() {
                count += 1;
                bytes += entry.metadata()?.len();
                if count > 2000 || bytes > 32 * 1024 * 1024 {
                    return Err(AppError::validation("plugin.runners.packageTooLarge"));
                }
                authorize(context, &["sftp.write"])?;
                let data = tokio::fs::read(entry.path()).await?;
                let mut file = sftp
                    .create(target)
                    .await
                    .map_err(|error| AppError::Ssh(error.to_string()))?;
                file.write_all(&data).await?;
                file.shutdown().await?;
            }
        }
    }
    Ok(())
}
