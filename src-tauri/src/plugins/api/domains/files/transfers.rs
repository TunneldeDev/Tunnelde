use crate::plugins::api::{authorize, encode, field, optional, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

fn check(context: &HostContext, permission: &str) -> AppResult<()> {
    authorize(context, &[permission])?;
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
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "files.local.copy" | "files.sftp.copy" => {
            let session: Option<String> = if method == "files.sftp.copy" {
                let session: String = field(&params, "sessionId")?;
                state.ssh.handle(&session)?;
                Some(session)
            } else {
                None
            };
            let task = crate::ssh::files::start_copy_checked(
                app.clone(),
                crate::ssh::files::Endpoint {
                    session: session.clone(),
                    path: field(&params, "from")?,
                },
                crate::ssh::files::Endpoint {
                    session,
                    path: field(&params, "to")?,
                },
                optional::<bool>(&params, "overwrite")?.unwrap_or(false),
                Some(crate::plugins::security::Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                }),
                &|| {
                    check(
                        context,
                        if method == "files.sftp.copy" {
                            "sftp.write"
                        } else {
                            "fs.write"
                        },
                    )
                },
            )?;
            let id = task.id.clone();
            if !crate::plugins::tools::register_resource(context, &id, true) {
                state
                    .transfers
                    .cancel_owned(&id, &context.id, context.generation);
                return Err(AppError::validation("plugin.tools.cancelled"));
            }
            let _request = crate::plugins::tools::CopyRequest(context.clone(), id);
            task.wait().await?;
            Ok(Value::Null)
        }
        "files.upload" | "files.download" => {
            let session_id: String = field(&params, "sessionId")?;
            // Validate the session before registering any background task.
            state.ssh.handle(&session_id)?;
            let local = crate::ssh::files::Endpoint {
                session: None,
                path: field(&params, "localPath")?,
            };
            let remote = crate::ssh::files::Endpoint {
                session: Some(session_id),
                path: field(&params, "remotePath")?,
            };
            let (from, to) = if method == "files.upload" {
                (local, remote)
            } else {
                (remote, local)
            };
            let transfer_id = crate::ssh::files::spawn_plugin_transfer_checked(
                app.clone(),
                from,
                to,
                optional::<bool>(&params, "overwrite")?.unwrap_or(false),
                crate::plugins::security::Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                },
                &|| check(context, "sftp.write"),
            )?;
            if !crate::plugins::tools::register_resource(context, &transfer_id, true) {
                state
                    .transfers
                    .cancel_owned(&transfer_id, &context.id, context.generation);
                return Err(AppError::validation("plugin.tools.cancelled"));
            }
            encode(transfer_id)
        }
        "files.cancelTransfer" => {
            check(context, "sftp.write")?;
            let value = encode(state.transfers.cancel_owned(
                &field::<String>(&params, "transferId")?,
                &context.id,
                context.generation,
            ));
            check(context, "sftp.write")?;
            value
        }
        "files.transferStatus" => {
            check(context, "sftp.read")?;
            let value = encode(state.transfers.status_owned(
                &field::<String>(&params, "transferId")?,
                &context.id,
                context.generation,
            ));
            check(context, "sftp.read")?;
            value
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
