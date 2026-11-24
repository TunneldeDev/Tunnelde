use crate::plugins::api::{authorize, encode, field, optional, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

fn check(
    context: &HostContext,
    permission: Option<&str>,
    policy: crate::plugins::frontend::native::CallPolicy,
) -> AppResult<()> {
    authorize(context, permission.as_slice())?;
    crate::platform::panel_windows::plugin_views::origin::check(policy)
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
                        Some(if method == "files.sftp.copy" {
                            "sftp.write"
                        } else {
                            "fs.write"
                        }),
                        crate::plugins::frontend::native::CallPolicy::OwnedData,
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
                &|| {
                    check(
                        context,
                        Some("sftp.write"),
                        crate::plugins::frontend::native::CallPolicy::OwnedData,
                    )
                },
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
            check(
                context,
                None,
                crate::plugins::frontend::native::CallPolicy::OwnedData,
            )?;
            let value = encode(state.transfers.cancel_owned(
                &field::<String>(&params, "transferId")?,
                &context.id,
                context.generation,
            ));
            check(
                context,
                None,
                crate::plugins::frontend::native::CallPolicy::OwnedData,
            )?;
            value
        }
        "files.transferStatus" => {
            check(
                context,
                None,
                crate::plugins::frontend::native::CallPolicy::StagedData,
            )?;
            let value = encode(state.transfers.status_owned(
                &field::<String>(&params, "transferId")?,
                &context.id,
                context.generation,
            ));
            check(
                context,
                None,
                crate::plugins::frontend::native::CallPolicy::StagedData,
            )?;
            value
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

#[cfg(test)]
mod tests {
    use crate::plugins::frontend::native::CallPolicy;

    #[test]
    fn owned_transfer_status_and_cancel_use_their_catalogue_policies_without_sftp_permissions() {
        assert_eq!(
            crate::plugins::api::method_info("files.transferStatus")
                .unwrap()
                .permissions,
            &[] as &[&str]
        );
        assert_eq!(
            crate::plugins::api::method_info("files.cancelTransfer")
                .unwrap()
                .permissions,
            &[] as &[&str]
        );
        assert_eq!(
            crate::plugins::frontend::native::call_policy("files.transferStatus"),
            Some(CallPolicy::StagedData)
        );
        assert_eq!(
            crate::plugins::frontend::native::call_policy("files.cancelTransfer"),
            Some(CallPolicy::OwnedData)
        );
    }
}
