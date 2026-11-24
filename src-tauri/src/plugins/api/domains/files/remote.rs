use crate::plugins::api::{authorize, encode, field, optional, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    if matches!(
        method,
        "files.sftp.resolveDirectory" | "files.sftp.list" | "files.sftp.readText"
    ) {
        let session = field::<String>(&params, "sessionId")?;
        let state = app.state::<AppState>();
        authorize(context, &["sftp.read"])?;
        let identity = state.ssh.identity(&session)?;
        let check = || {
            authorize(context, &["sftp.read"])?;
            if let Some(origin) = crate::platform::panel_windows::plugin_views::origin::current() {
                origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
            }
            if state.ssh.identity(&session)? != identity {
                return Err(AppError::validation("ssh.sessionMissing"));
            }
            Ok(())
        };
        let value = match method {
            "files.sftp.resolveDirectory" => encode(
                crate::ssh::files::remote_resolve_directory_checked(
                    app,
                    &session,
                    optional(&params, "path")?,
                    &check,
                )
                .await?,
            ),
            "files.sftp.list" => encode(
                commands::sftp_list_checked(
                    app.clone(),
                    session.clone(),
                    optional(&params, "path")?,
                    &check,
                )
                .await?,
            ),
            _ => encode(
                crate::ssh::files::read_plugin_text_checked(
                    app,
                    &session,
                    &field::<String>(&params, "path")?,
                    &check,
                )
                .await?,
            ),
        };
        check()?;
        return value;
    }
    match method {
        "files.sftp.writeText" => super::remote_write::write_remote(context, &params, None).await,
        "files.sftp.createFile"
        | "files.sftp.mkdir"
        | "files.sftp.rename"
        | "files.sftp.delete" => super::remote_mutation::dispatch(context, method, &params).await,
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
