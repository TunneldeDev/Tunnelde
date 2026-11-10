use crate::{
    error::{AppError, AppResult},
    plugins::{api::HostContext, security::Lease},
    services::plugin_configuration::{repository::Repository, service},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> AppResult<T> {
    serde_json::from_value(params).map_err(|_| AppError::validation("configuration.invalidRequest"))
}
pub(crate) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let context = context.clone();
    let method = method.to_owned();
    tauri::async_runtime::spawn_blocking(move || dispatch(&context, &method, params))
        .await
        .map_err(|_| AppError::internal("configuration.workerFailed"))?
}
fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let repo = Repository::at(
        state
            .storage
            .dir(crate::storage::layout::Category::PluginData),
    );
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let (result, changed) = state.plugins.security.with_authorized(&lease, &[], || {
        state
            .plugins
            .with_configuration(&context.id, &context.fingerprint, |schema| {
                let result = match method {
                    "configuration.schema" | "configuration.snapshot" | "configuration.backups" => {
                        if params.as_object().is_none_or(|p| !p.is_empty()) {
                            return Err(AppError::validation("configuration.invalidRequest"));
                        }
                        if method == "configuration.schema" {
                            return Ok((serde_json::to_value(schema)?, None));
                        }
                        if method == "configuration.backups" {
                            return Ok((
                                serde_json::to_value(service::list_backups(&repo, &context.id)?)?,
                                None,
                            ));
                        }
                        service::read(&repo, &context.id, schema)?
                    }
                    "configuration.update" => {
                        service::update(&repo, &context.id, schema, parse(params)?)?
                    }
                    "configuration.migrate" => {
                        service::migrate(&repo, &context.id, schema, parse(params)?)?
                    }
                    "configuration.restore" => {
                        service::restore(&repo, &context.id, schema, parse(params)?)?
                    }
                    "configuration.deleteBackup" => {
                        let snapshot =
                            service::delete_backup(&repo, &context.id, schema, parse(params)?)?;
                        return Ok((Value::Null, Some(snapshot)));
                    }
                    _ => return Err(AppError::validation("plugin.api.unknownMethod")),
                };
                let response = serde_json::to_value(&result)?;
                Ok((
                    response,
                    if method == "configuration.snapshot" {
                        None
                    } else {
                        Some(result)
                    },
                ))
            })
    })?;
    if let Some(snapshot) = changed {
        super::events::changed(&context.app, &context.id, method, &snapshot);
    }
    Ok(result)
}
