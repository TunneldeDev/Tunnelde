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
    match method {
        "files.local.home" => encode(commands::local_home()),
        "files.local.list" => encode(commands::local_list(optional(&params, "path")?)?),
        "files.local.readText" => super::text::local_read(field(&params, "path")?).await,
        "files.local.writeText" => super::text::write_local(context, &params, |_, _| Ok(())).await,
        "files.local.createFile" => {
            commands::local_create_file(field(&params, "path")?)?;
            Ok(Value::Null)
        }
        "files.local.mkdir" => {
            commands::local_mkdir(field(&params, "path")?)?;
            Ok(Value::Null)
        }
        "files.local.rename" => {
            // Plugin rename remains atomic. Copy-based moves require a
            // separately owned transfer lifecycle, not the UI fallback.
            crate::ssh::files::local_rename(
                field(&params, "from")?,
                field(&params, "to")?,
                optional(&params, "overwrite")?.unwrap_or(false),
            )?;
            Ok(Value::Null)
        }
        "files.local.delete" => {
            commands::local_delete(field(&params, "path")?, field(&params, "isDir")?)?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
