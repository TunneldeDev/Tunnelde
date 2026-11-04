//! Deployment and bounded RPC transport for optional user-owned remote runners.
use std::path::PathBuf;
use std::time::Duration;

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::api::{authorize, field, frontend_request, optional, HostContext};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// Serialize metadata transitions, including launch reservations and revocation.
static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Deployment {
    host_id: String,
    directory: String,
    platform: String,
    executable: String,
    runner: String,
    entry: String,
    #[serde(default)]
    fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    runner_id: String,
    deployment: Deployment,
    stop_pending: bool,
}

fn metadata(context: &HostContext) -> PathBuf {
    context
        .app
        .state::<AppState>()
        .storage
        .dir(crate::storage::layout::Category::Runners)
        .join(format!("{}.json", context.id))
}
fn load(context: &HostContext) -> AppResult<Vec<Record>> {
    match std::fs::read(metadata(context)) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => serde_json::from_slice(&bytes)
            .map_err(|_| AppError::validation("plugin.runners.invalidMetadata")),
        Ok(_) => Err(AppError::validation("plugin.runners.metadataTooLarge")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}
fn save(context: &HostContext, records: &[Record]) -> AppResult<()> {
    let path = metadata(context);
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| AppError::internal("plugin.runners.path"))?,
    )?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(records)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
fn path_join(directory: &str, name: &str, platform: &str) -> String {
    format!(
        "{}{}{name}",
        directory.trim_end_matches(['/', '\\']),
        if platform == "windows" { "\\" } else { "/" }
    )
}
fn validate_directory(directory: &str, platform: &str) -> AppResult<()> {
    if directory.is_empty()
        || directory.len() > 4096
        || directory.contains(['\0', '\n', '\r'])
        || directory.split(['/', '\\']).any(|part| part == "..")
        || !(if platform == "windows" {
            directory.as_bytes().get(1) == Some(&b':')
                && directory
                    .as_bytes()
                    .get(2)
                    .is_some_and(|byte| b"/\\".contains(byte))
        } else {
            directory.starts_with('/') && directory != "/"
        })
    {
        return Err(AppError::validation(
            "plugin.runners.absoluteDirectoryRequired",
        ));
    }
    Ok(())
}
fn host_id(context: &HostContext, session: &str) -> AppResult<String> {
    context
        .app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|info| info.id == session)
        .map(|info| info.host_id)
        .ok_or_else(|| AppError::validation("ssh.sessionMissing"))
}

async fn exec(
    context: &HostContext,
    session: &str,
    executable: &str,
    args: Vec<String>,
    platform: &str,
    input: Option<String>,
) -> AppResult<Value> {
    let command = super::tasks::remote_command(executable, &args, None, platform)?;
    let handle = context.app.state::<AppState>().ssh.handle(session)?;
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        if let Some(input) = input {
            channel
                .data(input.as_bytes())
                .await
                .map_err(|error| AppError::Ssh(error.to_string()))?;
        }
        channel
            .eof()
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
            if stdout.len() + stderr.len() > 1024 * 1024 {
                let _ = channel.close().await;
                return Err(AppError::validation("plugin.runners.outputTooLarge"));
            }
        }
        let _ = channel.close().await;
        if code != Some(0) {
            return Err(AppError::validation(format!(
                "plugin.runners.commandFailed:{}",
                String::from_utf8_lossy(&stderr)
                    .chars()
                    .take(512)
                    .collect::<String>()
            )));
        }
        serde_json::from_slice(&stdout)
            .map_err(|_| AppError::validation("plugin.runners.invalidResponse"))
    })
    .await
    .map_err(|_| AppError::validation("plugin.runners.timeout"))?
}

pub async fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let _mutation = MUTATIONS.lock().await;
    authorize(context, &["ssh.exec"])?;
    if method == "runners.list" {
        return Ok(json!(load(context)?));
    }
    if method == "runners.deploy" {
        return deploy(context, params).await;
    }
    let session: String = field(&params, "sessionId")?;
    let host = host_id(context, &session)?;
    if method == "runners.start" {
        let directory: String = field(&params, "directory")?;
        let mut records = load(context)?;
        if records.len() >= 256 {
            return Err(AppError::validation("plugin.runners.tooManyTasks"));
        }
        let deployment = records
            .iter()
            .find(|record| {
                record.runner_id == "deployment"
                    && record.deployment.host_id == host
                    && record.deployment.directory == directory
                    && record.deployment.fingerprint == context.fingerprint
            })
            .map(|record| record.deployment.clone())
            .ok_or_else(|| AppError::validation("plugin.runners.deployFirst"))?;
        let config: Value = field(&params, "config")?;
        let id = uuid::Uuid::new_v4().to_string();
        let config_path = path_join(
            &directory,
            &format!("config-{id}.json"),
            &deployment.platform,
        );
        let sftp = crate::ssh::files::session(&context.app, &session).await?;
        let mut file = sftp
            .create(&config_path)
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        file.write_all(&serde_json::to_vec(&config)?).await?;
        file.shutdown().await?;
        if deployment.platform != "windows" {
            sftp.set_metadata(
                &config_path,
                russh_sftp::protocol::FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        }
        let initial = json!({"secrets":params.get("secrets").cloned().unwrap_or_else(||json!({}))});
        // Persist before launch: a lost SSH response must still leave a cancellable record.
        records.push(Record {
            runner_id: id.clone(),
            deployment: deployment.clone(),
            stop_pending: true,
        });
        save(context, &records)?;
        authorize(context, &["ssh.exec"])?;
        let result = exec(
            context,
            &session,
            &deployment.runner,
            vec![
                "start".into(),
                "--directory".into(),
                directory.clone(),
                "--id".into(),
                id.clone(),
                "--config".into(),
                config_path,
                "--executable".into(),
                deployment.executable.clone(),
                "--entry".into(),
                deployment.entry.clone(),
            ],
            &deployment.platform,
            Some(format!("{initial}\n")),
        )
        .await?;
        if let Some(record) = records.iter_mut().find(|record| record.runner_id == id) {
            record.stop_pending = false;
        }
        save(context, &records)?;
        return Ok(result);
    }
    let id: String = field(&params, "runnerId")?;
    let mut records = load(context)?;
    let record = records
        .iter_mut()
        .find(|record| record.runner_id == id && record.deployment.host_id == host)
        .ok_or_else(|| AppError::validation("plugin.runners.notFound"))?;
    let deployment = record.deployment.clone();
    if record.stop_pending || method == "runners.stop" {
        record.stop_pending = true;
        save(context, &records)?;
        let result = exec(
            context,
            &session,
            &deployment.runner,
            vec![
                "stop".into(),
                "--directory".into(),
                deployment.directory.clone(),
                "--id".into(),
                id.clone(),
            ],
            &deployment.platform,
            None,
        )
        .await?;
        // Acknowledging a stop request does not prove that the process exited.
        confirm_stopped(context, &session, &deployment, &id, &mut records).await?;
        if method == "runners.stop" {
            return Ok(result);
        }
        if method == "runners.send" {
            return Err(AppError::validation("plugin.runners.stopPending"));
        }
    }
    let mut args = vec![
        match method {
            "runners.send" => "send",
            "runners.poll" => "poll",
            "runners.status" => "status",
            _ => return Err(AppError::validation("plugin.api.unknownMethod")),
        }
        .into(),
        "--directory".into(),
        deployment.directory,
        "--id".into(),
        id,
    ];
    let input = if method == "runners.send" {
        Some(format!("{}\n", field::<Value>(&params, "message")?))
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
    exec(
        context,
        &session,
        &deployment.runner,
        args,
        &deployment.platform,
        input,
    )
    .await
}

async fn deploy(context: &HostContext, params: Value) -> AppResult<Value> {
    authorize(context, &["fs.read", "sftp.write"])?;
    if load(context)?.len() >= 256 {
        return Err(AppError::validation("plugin.runners.tooManyTasks"));
    }
    let session: String = field(&params, "sessionId")?;
    let host = host_id(context, &session)?;
    let directory: String = field(&params, "directory")?;
    let platform: String = field(&params, "platform")?;
    if !matches!(platform.as_str(), "windows" | "posix") {
        return Err(AppError::validation("plugin.tasks.invalidPlatform"));
    }
    validate_directory(&directory, &platform)?;
    let executable: String = field(&params, "executable")?;
    let records = load(context)?;
    if let Some(existing) = records.iter().find(|record| {
        record.runner_id == "deployment"
            && record.deployment.host_id == host
            && record.deployment.directory == directory
    }) {
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
    };
    let mut records = load(context)?;
    records.push(Record {
        runner_id: "deployment".into(),
        deployment,
        stop_pending: false,
    });
    save(context, &records)?;
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

/// Entering safe mode records every stop first. Offline hosts remain visibly pending.
pub async fn revoke(context: &HostContext) {
    let _mutation = MUTATIONS.lock().await;
    let Ok(mut records) = load(context) else {
        return;
    };
    for record in records
        .iter_mut()
        .filter(|record| record.runner_id != "deployment")
    {
        record.stop_pending = true;
    }
    let _ = save(context, &records);
    flush_pending(context, &mut records).await;
}

async fn confirm_stopped(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
    id: &str,
    records: &mut [Record],
) -> AppResult<()> {
    let status = exec(
        context,
        session,
        &deployment.runner,
        vec![
            "status".into(),
            "--directory".into(),
            deployment.directory.clone(),
            "--id".into(),
            id.into(),
        ],
        &deployment.platform,
        None,
    )
    .await?;
    if matches!(
        status["status"].as_str(),
        Some("stopped" | "failed" | "notFound")
    ) {
        if let Some(record) = records.iter_mut().find(|record| record.runner_id == id) {
            record.stop_pending = false;
        }
        save(context, records)?;
    }
    Ok(())
}

async fn flush_pending(context: &HostContext, records: &mut [Record]) {
    let sessions = context.app.state::<AppState>().ssh.list();
    let pending: Vec<_> = records
        .iter()
        .filter(|record| record.stop_pending && record.runner_id != "deployment")
        .cloned()
        .collect();
    for record in &pending {
        if record.runner_id == "deployment" {
            continue;
        }
        if let Some(session) = sessions
            .iter()
            .find(|session| session.host_id == record.deployment.host_id)
        {
            let deployment = &record.deployment;
            let _ = exec(
                context,
                &session.id,
                &deployment.runner,
                vec![
                    "stop".into(),
                    "--directory".into(),
                    deployment.directory.clone(),
                    "--id".into(),
                    record.runner_id.clone(),
                ],
                &deployment.platform,
                None,
            )
            .await;
            let _ =
                confirm_stopped(context, &session.id, deployment, &record.runner_id, records).await;
        }
    }
}

/// Retry recorded stops on SSH reconnect, even when safe mode prevents plugin startup.
pub async fn on_reconnect(app: &tauri::AppHandle) {
    let _mutation = MUTATIONS.lock().await;
    let directory = app
        .state::<AppState>()
        .storage
        .dir(crate::storage::layout::Category::Runners)
        .to_owned();
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !super::manifest::valid_id(id) {
            continue;
        }
        let context = HostContext {
            app: app.clone(),
            id: id.into(),
            fingerprint: String::new(),
            permissions: Vec::new(),
            generation: 0,
            tool_client: None,
        };
        if let Ok(mut records) = load(&context) {
            flush_pending(&context, &mut records).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_traversal() {
        for path in ["/", "../x", "/tmp/../x"] {
            assert!(validate_directory(path, "posix").is_err());
        }
        assert!(validate_directory("/home/user/tunnelde-agent", "posix").is_ok());
        assert!(validate_directory("C:\\AgentData\\test\\agent", "windows").is_ok());
    }
}
