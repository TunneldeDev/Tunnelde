use super::{
    adapters,
    contracts::{
        release::{Request, Response},
        snapshot::Query,
    },
    identity, projection,
};
use crate::{
    error::{AppError, AppResult},
    plugins::api::HostContext,
};
use serde_json::Value;

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> AppResult<T> {
    serde_json::from_value(params)
        .map_err(|_| AppError::validation("plugin.resources.invalidRequest"))
}
pub(in crate::plugins) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let permit = super::admission::acquire(&context.id)?;
    match method {
        "resources.snapshot" => {
            let query = parse::<Query>(params)?;
            let items = collect(context).await?;
            Ok(serde_json::to_value(projection::page(
                items.into_iter().map(|e| e.resource).collect(),
                query,
            )?)?)
        }
        "resources.release" => {
            let request: Request = parse(params)?;
            if !identity::valid(&request.handle) {
                return Err(AppError::validation("plugin.resources.invalidRequest"));
            }
            let entry = tokio::time::timeout(
                super::OBSERVATION_TIMEOUT,
                adapters::resolve(context, &request.handle),
            )
            .await
            .map_err(|_| AppError::validation("plugin.resources.busy"))??;
            let context = context.clone();
            // Once disposal is submitted, a lost transport must not interrupt
            // socket/FUSE cleanup. Capacity stays held until the worker settles.
            let outcome = tauri::async_runtime::spawn(async move {
                let _permit = permit;
                adapters::release(&context, entry.target).await
            })
            .await
            .map_err(|_| AppError::internal("plugin.resources.workerFailed"))??;
            Ok(serde_json::to_value(Response {
                handle: request.handle,
                outcome,
            })?)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

async fn collect(context: &HostContext) -> AppResult<Vec<adapters::Entry>> {
    tokio::time::timeout(super::OBSERVATION_TIMEOUT, adapters::collect(context))
        .await
        .map_err(|_| AppError::validation("plugin.resources.busy"))?
}
