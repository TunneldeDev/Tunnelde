use crate::plugins::{
    api::{authorize, encode, field, optional, HostContext},
    security::Lease,
};
use crate::{
    error::{AppError, AppResult},
    services::hosts::ssh_config,
};
use serde_json::Value;

mod mutations;
mod routes;
mod transfer;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    match method {
        "hosts.transfer.export" | "hosts.transfer.preview" | "hosts.transfer.apply" => {
            transfer::call(context, method, params).await
        }
        "hosts.routes.get" | "hosts.routes.observe" | "hosts.routes.save" => {
            routes::call(context, method, params).await
        }
        "hosts.snapshot" => {
            let worker = context.clone();
            encode(
                crate::services::hosts::read::snapshot(app, move || {
                    authorize(&worker, &["hosts.read"])
                })
                .await?,
            )
        }
        "hosts.sshConfig.preview" => encode(
            ssh_config::preview_page(
                app,
                lease(context),
                optional(&params, "offset")?.unwrap_or_default(),
                optional(&params, "revision")?,
            )
            .await?,
        ),
        "hosts.sshConfig.import" => {
            let result = ssh_config::import_checked(
                app,
                field(&params, "aliases")?,
                field(&params, "revision")?,
                Some(lease(context)),
            )
            .await?;
            Ok(serde_json::json!({
                "importedIds": result.imported.into_iter().map(|host| host.id).collect::<Vec<_>>(),
                "skipped": result.skipped,
            }))
        }
        "hosts.setSource" | "hosts.removeSource" | "hosts.sourcesSnapshot" => {
            crate::plugins::host_sources::call(context, method, params)
        }
        "hostList.setColumn" | "hostList.removeColumn" => {
            crate::plugins::host_columns::call(context, method, params)
        }
        "hosts.getFields" | "hosts.setFields" => {
            crate::plugins::host_fields::call(context, method, params).await
        }
        "hosts.create" | "hosts.update" | "hosts.delete" | "hosts.markUsed" | "hosts.reorder"
        | "groups.create" | "groups.update" | "groups.delete" => {
            mutations::call(context, method, params).await
        }
        "hostList.setDecorations" | "hostList.removeDecorations" => {
            crate::plugins::host_list::call(context, method, params)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

fn lease(context: &HostContext) -> Lease {
    Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    }
}
