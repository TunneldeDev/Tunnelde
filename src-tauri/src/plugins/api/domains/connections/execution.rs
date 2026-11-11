use crate::plugins::api::{authorize, field, optional, HostContext, MAX_PAYLOAD};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use russh::ChannelMsg;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;

// Cancellation drops the host dispatch future immediately. Close the dedicated
// channel from a detached, bounded cleanup task even when that future cannot
// reach its normal async cleanup path.
struct ExecChannel(Option<russh::Channel<russh::client::Msg>>);

impl Drop for ExecChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
                });
            }
        }
    }
}

pub(in crate::plugins::api) async fn execute(
    context: &HostContext,
    params: &Value,
) -> AppResult<Value> {
    let session_id: String = field(params, "sessionId")?;
    let command: String = field(params, "command")?;
    let timeout = optional::<u64>(params, "timeoutMs")?.unwrap_or(20_000);
    if !(100..=60_000).contains(&timeout)
        || command.trim().is_empty()
        || command.len() > 64 * 1024
        || command.contains('\0')
    {
        return Err(AppError::validation("plugin.api.invalidExec"));
    }
    let handle = context.app.state::<AppState>().ssh.handle(&session_id)?;
    let channel = tokio::time::timeout(Duration::from_secs(8), handle.channel_open_session())
        .await
        .map_err(|_| AppError::validation("plugin.api.execTimeout"))?
        .map_err(|error| AppError::Ssh(format!("plugin.exec.channel:{error}")))?;
    let mut guard = ExecChannel(Some(channel));
    let channel = guard.0.as_mut().expect("exec channel is present");
    let result = tokio::time::timeout(Duration::from_millis(timeout), async {
        authorize(context, &["ssh.exec"])?;
        channel.exec(true, command).await.map_err(|error| AppError::Ssh(format!("plugin.exec:{error}")))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut signal = None;
        loop {
            tokio::select! {
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => signal = Some(format!("{signal_name:?}")),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                _ = tokio::time::sleep(Duration::from_millis(250)) => { authorize(context, &["ssh.exec"])?; }
            }
            if stdout.len().saturating_add(stderr.len()) > MAX_PAYLOAD { return Err(AppError::validation("plugin.api.outputTooLarge")); }
        }
        Ok(json!({"stdout":String::from_utf8_lossy(&stdout),"stderr":String::from_utf8_lossy(&stderr),"exitCode":exit_code,"signal":signal}))
    }).await.unwrap_or_else(|_| Err(AppError::validation("plugin.api.execTimeout")));
    let _ = channel.close().await;
    guard.0.take();
    result
}
