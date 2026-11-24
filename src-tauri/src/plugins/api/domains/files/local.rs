use crate::plugins::api::{authorize, encode, field, optional, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
    ssh::files,
};
use serde_json::Value;

fn read_effect(context: &HostContext) -> AppResult<()> {
    authorize(context, &["fs.read"])?;
    if let Some(origin) = crate::platform::panel_windows::plugin_views::origin::current() {
        origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
    }
    Ok(())
}

fn write_effect(context: &HostContext) -> AppResult<()> {
    authorize(context, &["fs.write"])?;
    if let Some(origin) = crate::platform::panel_windows::plugin_views::origin::current() {
        origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
    }
    Ok(())
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        "files.local.home" => encode(commands::local_home()),
        // Keep plugin filesystem calls immediate after the dispatcher's
        // authorization. Native worker queuing must not introduce a new
        // revoke/close-before-commit window into this adapter.
        "files.local.list" => {
            read_effect(context)?;
            let value = encode(files::local_list(optional(&params, "path")?)?);
            read_effect(context)?;
            value
        }
        "files.local.readText" => {
            read_effect(context)?;
            let value = super::text::local_read(field(&params, "path")?).await;
            if value.is_ok() {
                read_effect(context)?;
            }
            value
        }
        "files.local.writeText" => {
            write_effect(context)?;
            let value = super::text::write_local(context, &params, |_, _| Ok(())).await;
            if value.is_ok() {
                write_effect(context)?;
            }
            value
        }
        "files.local.createFile" => {
            write_effect(context)?;
            files::local_create_file(field(&params, "path")?)?;
            write_effect(context)?;
            Ok(Value::Null)
        }
        "files.local.mkdir" => {
            write_effect(context)?;
            files::local_mkdir(field(&params, "path")?)?;
            write_effect(context)?;
            Ok(Value::Null)
        }
        "files.local.rename" => {
            write_effect(context)?;
            // Plugin rename remains atomic. Copy-based moves require a
            // separately owned transfer lifecycle, not the UI fallback.
            crate::ssh::files::local_rename(
                field(&params, "from")?,
                field(&params, "to")?,
                optional(&params, "overwrite")?.unwrap_or(false),
            )?;
            write_effect(context)?;
            Ok(Value::Null)
        }
        "files.local.delete" => {
            write_effect(context)?;
            files::local_delete(field(&params, "path")?, field(&params, "isDir")?)?;
            write_effect(context)?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
