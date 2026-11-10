//! Bounded SSH helper protocol; never owns repository locks.
use super::{Deployment, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use russh::ChannelMsg;
use serde_json::Value;
use std::time::Duration;
use tauri::Manager;

pub(super) async fn exec(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
    args: Vec<String>,
    input: Option<String>,
) -> AppResult<Value> {
    super::identity::verify(
        deployment,
        &super::identity::capture(&context.app, session)?,
    )?;
    let command = crate::plugins::tasks::remote_command(
        &deployment.runner,
        &args,
        None,
        &deployment.platform,
    )?;
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
