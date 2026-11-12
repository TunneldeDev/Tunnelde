//! Remote plugin publication policy; network checks never hold policy locks.
use super::write_policy::Authorization;
use crate::{
    error::{AppError, AppResult},
    plugins::{
        api::{authorize, field, optional, HostContext},
        tools::remote_write::RemoteWriteApproval,
    },
    services::files::operations::Cancellation,
    ssh::files::remote_editor::policy::Policy,
    state::AppState,
};
use russh_sftp::client::SftpSession;
use serde_json::Value;
use tauri::Manager;

struct RemotePolicy {
    authorization: Authorization,
    session_id: String,
    host_id: String,
    address: String,
    approval: Option<RemoteWriteApproval>,
}

impl RemotePolicy {
    fn connected(&self) -> AppResult<()> {
        let valid = self
            .authorization
            .context
            .app
            .state::<AppState>()
            .ssh
            .list()
            .iter()
            .any(|s| {
                s.id == self.session_id && s.host_id == self.host_id && s.address == self.address
            });
        if valid {
            Ok(())
        } else {
            Err(AppError::validation("sftp.reconnectRequired"))
        }
    }

    fn authorized(&self) -> AppResult<()> {
        self.authorization.check()?;
        self.connected()
    }
}

impl Policy for RemotePolicy {
    fn authorize(&self) -> AppResult<()> {
        self.authorized()
    }

    async fn check(&self, sftp: &SftpSession, target: &str, original: &str) -> AppResult<()> {
        self.authorized()?;
        if let Some(approval) = &self.approval {
            approval.check(sftp, target, original).await?;
        }
        self.authorized()
    }

    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        self.authorization.admit(job, || self.connected())
    }
}

pub(in crate::plugins) async fn write_remote(
    context: &HostContext,
    params: &Value,
    approval: Option<RemoteWriteApproval>,
) -> AppResult<Value> {
    authorize(context, &["sftp.write"])?;
    let session_id: String = field(params, "sessionId")?;
    let session = context
        .app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| AppError::validation("sftp.reconnectRequired"))?;
    let policy = RemotePolicy {
        authorization: Authorization::new(context, "sftp.write"),
        session_id: session_id.clone(),
        host_id: session.host_id,
        address: session.address,
        approval,
    };
    crate::ssh::files::write_text_checked(
        &context.app,
        &session_id,
        &field::<String>(params, "path")?,
        &field::<String>(params, "content")?,
        optional::<String>(params, "baseline")?.as_deref(),
        policy,
    )
    .await?;
    Ok(Value::Null)
}
