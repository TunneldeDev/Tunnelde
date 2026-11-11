//! Explicit endpoint authorization surrounds ownership and post-await delivery.
use crate::{
    error::{AppError, AppResult},
    plugins::{
        api::{encode, HostContext},
        files::content::contracts::*,
        security::Lease,
    },
    services::files::read::Source,
    state::AppState,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::Manager;

fn parse<T: DeserializeOwned>(params: Value) -> AppResult<T> {
    serde_json::from_value(params).map_err(|_| invalid())
}
pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    // Scoped AI tools must obtain a dedicated path/handle contract before these
    // methods join that gateway's allowlist. Ordinary plugins use explicit grants.
    if context.tool_client.is_some() || context.tool_request.is_some() {
        return Err(invalid());
    }
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    match method {
        "files.content.prepare" => {
            let request: Prepare = parse(params)?;
            request.validate()?;
            let permission = request.source.permission();
            // No disk, channel, shell or file IO occurs in the prepare phase.
            let result = state
                .plugins
                .security
                .with_authorized(&lease, &[permission], || {
                    state.plugins.file_content.prepare(lease.clone(), request)
                })?;
            encode(result)
        }
        "files.content.open" => {
            let request: Reference = parse(params)?;
            let entry = state.plugins.file_content.get(
                &context.id,
                context.generation,
                &request.content_id,
            )?;
            let permission = entry.request.source.permission();
            let opening = state
                .plugins
                .security
                .with_authorized(&lease, &[permission], || entry.begin())?;
            let (source, size) = tokio::time::timeout(
                std::time::Duration::from_millis(PREPARED_MS),
                Source::open(
                    &context.app,
                    entry.request.source.session(),
                    &entry.request.path,
                ),
            )
            .await
            .map_err(|_| AppError::validation("plugin.timeout"))??;
            // A cancellation/revocation/expiry can retire the descriptor while IO
            // settles. Opening retains RAII ownership until the authorized install.
            let result = state
                .plugins
                .security
                .with_authorized(&lease, &[permission], || opening.finish(source, size))?;
            encode(result)
        }
        "files.content.read" => {
            let request: Read = parse(params)?;
            request.validate()?;
            let entry = state.plugins.file_content.get(
                &context.id,
                context.generation,
                &request.content_id,
            )?;
            let permission = entry.request.source.permission();
            let reading = state
                .plugins
                .security
                .with_authorized(&lease, &[permission], || {
                    entry.read(request.offset, request.length)
                })?;
            let bytes = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                reading.source.read(reading.offset, reading.length),
            )
            .await
            .map_err(|_| AppError::validation("plugin.timeout"))??;
            let chunk = state
                .plugins
                .security
                .with_authorized(&lease, &[permission], || reading.finish(bytes))?;
            encode(chunk)
        }
        "files.content.close" => {
            let request: Reference = parse(params)?;
            state.plugins.security.with_authorized(&lease, &[], || {
                state.plugins.file_content.close(
                    &context.id,
                    context.generation,
                    &request.content_id,
                )
            })?;
            Ok(json!({"version":1,"closed":true}))
        }
        "files.content.observe" => {
            let request: Reference = parse(params)?;
            id(&request.content_id)?;
            let observed = state.plugins.security.with_authorized(&lease, &[], || {
                Ok(state
                    .plugins
                    .file_content
                    .get(&context.id, context.generation, &request.content_id)
                    .map(|entry| entry.observe())
                    .unwrap_or(Observation {
                        version: 1,
                        content_id: request.content_id,
                        state: Phase::Closed,
                        size: None,
                        chunk_bytes: MAX_CHUNK,
                        lease_ms: 0,
                    }))
            })?;
            encode(observed)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
