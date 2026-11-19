use crate::{
    error::{AppError, AppResult},
    platform::panel_windows::public,
    plugins::{
        api::{authorize, field, optional, HostContext},
        security::Lease,
    },
};
use serde_json::Value;

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        "workspace.windows.list" | "workspace.panels.ownership" => {
            authorize(context, &["workspace.read"])?;
            Ok(public::snapshot(&context.app))
        }
        "workspace.windows.observe" => {
            authorize(context, &["workspace.read"])?;
            let revision: Option<String> = optional(&params, "revision")?;
            if revision
                .as_ref()
                .is_some_and(|revision| revision.len() > 128 || revision.contains('\0'))
            {
                return Err(AppError::validation("plugin.api.invalid:revision"));
            }
            Ok(public::observe(&context.app, revision).await)
        }
        "workspace.panels.moveToWindow" => {
            authorize(context, &["workspace.write"])?;
            let request = serde_json::from_value(params)
                .map_err(|_| AppError::validation("plugin.api.invalid:move"))?;
            public::move_panel(
                &context.app,
                Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                },
                request,
            )
            .await
        }
        "workspace.windows.create" => {
            authorize(context, &["workspace.write"])?;
            public::create(
                &context.app,
                Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                },
            )
            .await
        }
        "workspace.windows.close" => {
            let id: String = field(&params, "windowId")?;
            if id.is_empty() || id.len() > 128 || id.contains('\0') {
                return Err(AppError::validation("plugin.api.invalid:windowId"));
            }
            authorize(context, &["workspace.write"])?;
            public::close(&context.app, &id)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
