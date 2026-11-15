//! Streaming remote processes retain channel and input-task ownership through cancellation.
use super::{
    authorize, cancelled, publish, task_error, until_cancelled, Decoder, HostContext, Input,
    TaskInput,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use russh::ChannelMsg;
use std::time::Duration;
use tauri::Manager;

mod opening;

struct InputOwner(tokio::task::AbortHandle);
impl Drop for InputOwner {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) async fn run(
    context: &HostContext,
    id: &str,
    session: &str,
    command: String,
    timeout: u64,
    input: TaskInput,
) -> AppResult<()> {
    let TaskInput {
        mut receiver,
        mut cancellation,
    } = input;
    let expires = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let handle = context.app.state::<AppState>().ssh.handle(session)?;
    let opened = opening::open(
        handle,
        expires.min(tokio::time::Instant::now() + Duration::from_secs(10)),
        &mut cancellation,
    )
    .await?;
    let Some(mut owned) = opened else {
        publish(
            context,
            id,
            "status",
            String::new(),
            Some("cancelled"),
            None,
        );
        return Ok(());
    };
    let channel = owned.channel();
    let started = until_cancelled(
        async {
            authorize(context, &["ssh.exec"])?;
            tokio::time::timeout_at(expires, channel.exec(true, command))
                .await
                .map_err(|_| AppError::validation("plugin.tasks.channelTimeout"))?
                .map_err(|error| AppError::Ssh(error.to_string()))
        },
        &mut cancellation,
    )
    .await;
    if !matches!(started, Some(Ok(()))) {
        let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
        if let Some(Err(error)) = started {
            return Err(error);
        }
        publish(
            context,
            id,
            "status",
            String::new(),
            Some("cancelled"),
            None,
        );
        return Ok(());
    }
    let mut split = owned.split();
    let (channel, channel_writer) = split.parts();
    let input_writer = channel_writer.clone();
    let mut writer_cancel = cancellation.clone();
    let mut writer = tokio::spawn(async move {
        until_cancelled(
            async {
                while let Some(command) = receiver.recv().await {
                    match command {
                        Input::Write(data) => input_writer.data(data.as_bytes()).await?,
                        Input::Eof => return input_writer.eof().await,
                    }
                }
                Ok::<(), russh::Error>(())
            },
            &mut writer_cancel,
        )
        .await
    });
    let _writer_owner = InputOwner(writer.abort_handle());
    let mut input_ended = false;
    let mut interval = tokio::time::interval(Duration::from_millis(200));
    let deadline = tokio::time::sleep_until(expires);
    tokio::pin!(deadline);
    let mut exit = None;
    let mut reason = "completed";
    let mut decoders = [Decoder::default(), Decoder::default()];
    loop {
        tokio::select! {
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) => { let text = decoders[0].push(&data, false); if !text.is_empty() { publish(context, id, "stdout", text, None, None); } },
                Some(ChannelMsg::ExtendedData { data, .. }) => { let text = decoders[1].push(&data, false); if !text.is_empty() { publish(context, id, "stderr", text, None, None); } },
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = i32::try_from(exit_status).ok(),
                Some(ChannelMsg::Close) | None => {
                    if exit.is_none() {
                        reason = "failed";
                        task_error(id, "SSH channel closed without an exit status");
                    }
                    break;
                },
                _ => {}
            },
            _ = cancelled(&mut cancellation) => { reason = "cancelled"; break; },
            result = &mut writer, if !input_ended => {
                input_ended = true;
                match result {
                    Ok(Some(Err(error))) => { task_error(id, error); reason = "failed"; break; }
                    Err(error) => { task_error(id, error); reason = "failed"; break; }
                    _ => {}
                }
            },
            _ = interval.tick() => if authorize(context, &["ssh.exec"]).is_err() { reason = "cancelled"; break; },
            _ = &mut deadline => { reason = "timedOut"; break; }
        }
    }
    writer.abort();
    if reason != "completed" {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            channel_writer.signal(russh::Sig::KILL),
        )
        .await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), channel_writer.close()).await;
    for (index, decoder) in decoders.iter_mut().enumerate() {
        let data = decoder.push(&[], true);
        if !data.is_empty() {
            publish(
                context,
                id,
                if index == 0 { "stdout" } else { "stderr" },
                data,
                None,
                None,
            );
        }
    }
    publish(context, id, "status", String::new(), Some(reason), exit);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retiring_remote_owner_aborts_input_writer() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(async move {
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        let owner = InputOwner(writer.abort_handle());
        drop(owner);
        assert!(writer.await.err().unwrap().is_cancelled());
    }
}
