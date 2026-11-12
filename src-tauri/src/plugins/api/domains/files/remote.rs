use crate::plugins::api::{encode, field, optional, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    match method {
        "files.sftp.resolveDirectory" => encode(
            crate::ssh::files::remote_resolve_directory(
                app,
                &field::<String>(&params, "sessionId")?,
                optional(&params, "path")?,
            )
            .await?,
        ),
        "files.sftp.list" => encode(
            commands::sftp_list(
                app.clone(),
                field(&params, "sessionId")?,
                optional(&params, "path")?,
            )
            .await?,
        ),
        "files.sftp.readText" => encode(
            commands::sftp_read_text(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
            )
            .await?,
        ),
        "files.sftp.writeText" => super::remote_write::write_remote(context, &params, None).await,
        "files.sftp.createFile"
        | "files.sftp.mkdir"
        | "files.sftp.rename"
        | "files.sftp.delete" => super::remote_mutation::dispatch(context, method, &params).await,
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
