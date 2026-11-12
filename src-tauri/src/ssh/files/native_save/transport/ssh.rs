use super::super::contracts::{
    authority::{Context, Platform},
    MAX_OUTPUT, MAX_PACKET,
};
use super::{Exchange, Failure, Output, Reason};
use crate::{ssh::session::SessionIdentity, state::AppState};
use russh::ChannelMsg;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub(in super::super) struct Ssh {
    app: AppHandle,
    session: String,
    identity: SessionIdentity,
    context: Context,
    command: String,
}
impl Ssh {
    // The caller must finish explicit install/runtime approval first. No RPC/UI
    // can construct this adapter until the corresponding consent flow is wired.
    pub fn selected(
        app: AppHandle,
        session: String,
        identity: SessionIdentity,
        platform: Platform,
        executable: &str,
        directory: &str,
        canonical_scope: String,
    ) -> Result<Self, Failure> {
        if !platform.absolute(executable) || !platform.absolute(directory) {
            return Err(Failure::before(Reason::InvalidRequest));
        }
        let command = crate::ssh::command::remote(
            executable,
            &["files-save".into(), "--directory".into(), directory.into()],
            None,
            platform.shell(),
        )
        .map_err(|_| Failure::before(Reason::InvalidRequest))?;
        let context = Context::authenticated(&identity, canonical_scope, platform)
            .ok_or(Failure::before(Reason::InvalidRequest))?;
        let value = Self {
            app,
            session,
            identity,
            context,
            command,
        };
        value.verify()?;
        Ok(value)
    }
    pub fn context(&self) -> &Context {
        &self.context
    }
    fn verify(&self) -> Result<(), Failure> {
        let actual = self
            .app
            .state::<AppState>()
            .ssh
            .identity(&self.session)
            .map_err(|_| Failure::before(Reason::Transport))?;
        if actual != self.identity {
            return Err(Failure::before(Reason::AuthorityChanged));
        }
        Ok(())
    }
}
impl Exchange for Ssh {
    fn authorize(&self, context: &Context) -> Result<(), Failure> {
        if self.context != *context {
            return Err(Failure::before(Reason::AuthorityChanged));
        }
        self.verify()
    }
    async fn exchange(&self, input: Vec<u8>) -> Result<Output, Failure> {
        if input.len() > MAX_PACKET {
            return Err(Failure::before(Reason::InvalidRequest));
        }
        self.verify()?;
        let handle = self
            .app
            .state::<AppState>()
            .ssh
            .handle(&self.session)
            .map_err(|_| Failure::before(Reason::Transport))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut channel = tokio::time::timeout_at(deadline, handle.channel_open_session())
            .await
            .map_err(|_| Failure::before(Reason::Timeout))?
            .map_err(|_| Failure::before(Reason::Transport))?;
        let mut dispatched = false;
        let result = tokio::time::timeout_at(deadline, async {
            self.verify()?;
            // Set before exec await: delivery loss cannot prove exec was rejected.
            dispatched = true;
            channel
                .exec(true, self.command.as_str())
                .await
                .map_err(|_| Reason::Transport)?;
            channel
                .data(input.as_slice())
                .await
                .map_err(|_| Reason::Transport)?;
            channel.eof().await.map_err(|_| Reason::Transport)?;
            let mut output = Output {
                stdout: Vec::new(),
                stderr: Vec::new(),
                code: None,
            };
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if data.len()
                            > MAX_OUTPUT.saturating_sub(output.stdout.len() + output.stderr.len())
                        {
                            return Err(Reason::OutputTooLarge.into());
                        }
                        output.stdout.extend_from_slice(&data);
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        if data.len()
                            > MAX_OUTPUT.saturating_sub(output.stdout.len() + output.stderr.len())
                        {
                            return Err(Reason::OutputTooLarge.into());
                        }
                        output.stderr.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        if output.code.replace(exit_status).is_some() {
                            return Err(Reason::InvalidResponse.into());
                        }
                    }
                    ChannelMsg::Close => break,
                    _ => (),
                }
            }
            Ok(output)
        })
        .await;
        // The remote worker may outlive this channel. The host journal must
        // retain its original operation on every uncertain dispatched failure.
        let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
        result
            .map_err(|_| Failure {
                reason: Reason::Timeout,
                dispatched,
            })?
            .map_err(|failure: Failure| Failure {
                dispatched: dispatched || failure.dispatched,
                ..failure
            })
    }
}
impl From<Reason> for Failure {
    fn from(reason: Reason) -> Self {
        Self::before(reason)
    }
}
