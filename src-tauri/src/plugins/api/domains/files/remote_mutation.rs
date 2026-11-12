//! Plugin mutation policy follows actual detached workers and composite steps.
use super::write_policy::Authorization;
use crate::{
    error::AppResult,
    plugins::api::{field, optional, HostContext},
    ssh::{
        files::mutations::{self, Policy},
        session::SessionIdentity,
    },
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

struct RemotePolicy {
    authorization: Authorization,
    session_id: String,
    destination: SessionIdentity,
}
impl Policy for RemotePolicy {
    fn with_authorized(&self, validate: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        self.authorization.with_authorized(|| {
            let current = self
                .authorization
                .context
                .app
                .state::<AppState>()
                .ssh
                .identity(&self.session_id)?;
            if current != self.destination {
                return Err(crate::error::AppError::validation("editor.nativeChanged"));
            }
            validate()
        })
    }
}

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: &Value,
) -> AppResult<Value> {
    let session_id: String = field(params, "sessionId")?;
    let policy = RemotePolicy {
        authorization: Authorization::new(context, "sftp.write"),
        destination: context.app.state::<AppState>().ssh.identity(&session_id)?,
        session_id: session_id.clone(),
    };
    policy.with_authorized(|| Ok(()))?;
    let app = &context.app;
    match method {
        "files.sftp.createFile" => {
            mutations::create_file(app, &session_id, field(params, "path")?, policy).await?
        }
        "files.sftp.mkdir" => {
            mutations::mkdir(app, &session_id, field(params, "path")?, policy).await?
        }
        "files.sftp.delete" => {
            // Preserve required legacy input validation, while actual metadata
            // decides link/directory behavior on the authenticated server.
            let _: bool = field(params, "isDir")?;
            mutations::delete(app, &session_id, field(params, "path")?, policy).await?;
        }
        "files.sftp.rename" => {
            mutations::rename(
                app,
                &session_id,
                field(params, "from")?,
                field(params, "to")?,
                optional(params, "overwrite")?.unwrap_or(false),
                policy,
            )
            .await?
        }
        _ => {
            return Err(crate::error::AppError::validation(
                "plugin.api.unknownMethod",
            ))
        }
    }
    Ok(Value::Null)
}
