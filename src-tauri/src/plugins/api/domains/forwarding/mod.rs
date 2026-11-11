//! Plugin RPC adapter for forwarding. Authorization and runtime ownership stay at this boundary.
use crate::plugins::api::{authorize, encode, field, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "forwards.list" => encode(crate::services::forwarding::list(app)?),
        "forwards.save" => encode(crate::services::forwarding::save(
            app,
            field(&params, "rule")?,
        )?),
        "forwards.remove" => {
            crate::services::forwarding::remove(app, &field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "forwards.start" => {
            let lease = crate::plugins::security::Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            let result = state
                .plugins
                .security
                .guard(
                    &lease,
                    crate::services::forwarding::prepare_checked(
                        app,
                        &field::<String>(&params, "id")?,
                        &field::<String>(&params, "sessionId")?,
                        Some((context.id.clone(), context.generation)),
                        None,
                    ),
                )
                .await;
            if let Err(error) = authorize(context, &["forwards.write"]) {
                state
                    .forwards
                    .stop_generation(&context.id, context.generation);
                return Err(error);
            }
            let prepared = result?;
            state
                .plugins
                .security
                .with_authorized(&lease, &["forwards.write"], || prepared.commit())?;
            Ok(Value::Null)
        }
        "forwards.stop" => {
            crate::services::forwarding::stop(app, &field::<String>(&params, "id")?).await?;
            Ok(Value::Null)
        }

        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
