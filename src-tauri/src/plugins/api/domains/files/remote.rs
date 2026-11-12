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
        "files.sftp.createFile" => {
            commands::sftp_create_file(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.mkdir" => {
            commands::sftp_mkdir(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.rename" => {
            commands::sftp_rename(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "from")?,
                field(&params, "to")?,
                optional(&params, "overwrite")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.delete" => {
            commands::sftp_delete(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
                field(&params, "isDir")?,
            )
            .await?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
