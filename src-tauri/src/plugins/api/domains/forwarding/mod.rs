//! Plugin RPC adapter for forwarding. Authorization and runtime ownership stay at this boundary.
mod batch;
mod groups;

use crate::plugins::{
    api::{authorize, encode, field, HostContext},
    security::Lease,
};
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
        name if name.starts_with("forwards.groups.") || name == "forwards.move" => {
            groups::dispatch(context, name, params)
        }
        "forwards.startManaged" => {
            start_managed(
                context,
                &field::<String>(&params, "id")?,
                &field::<String>(&params, "expectedRevision")?,
                None,
            )
            .await?;
            Ok(Value::Null)
        }
        "forwards.startManyManaged" => batch::start_managed(context, params).await,
        "forwards.automation.list" => encode(crate::services::forwarding::automation::list(app)?),
        "forwards.automation.save" => {
            let id: String = field(&params, "id")?;
            let revision: String = field(&params, "expectedRevision")?;
            let options = field(&params, "automation")?;
            let lease = Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            let entry = crate::services::forwarding::find(app, &id)?
                .ok_or_else(|| AppError::validation("forward.missing"))?;
            let mutation = || {
                state
                    .plugins
                    .security
                    .with_authorized(&lease, &["forwards.write"], || {
                        encode(crate::services::forwarding::automation::save(
                            app,
                            entry.info.rule,
                            Some(&revision),
                            options,
                        )?)
                    })
            };
            match origin {
                Some(origin) => origin.with_current(mutation),
                None => mutation(),
            }
        }
        "forwards.list" => encode(crate::services::forwarding::list(app)?),
        "forwards.save" => {
            let rule = field(&params, "rule")?;
            let lease = Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            let mutation = || {
                state
                    .plugins
                    .security
                    .with_authorized(&lease, &["forwards.write"], || {
                        encode(crate::services::forwarding::save(app, rule))
                    })
            };
            match origin {
                Some(origin) => origin.with_current(mutation),
                None => mutation(),
            }
        }
        "forwards.remove" => {
            let id = field::<String>(&params, "id")?;
            let lease = Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            let mutation = || {
                state
                    .plugins
                    .security
                    .with_authorized(&lease, &["forwards.write"], || {
                        crate::services::forwarding::remove(app, &id)?;
                        Ok(Value::Null)
                    })
            };
            match origin {
                Some(origin) => origin.with_current(mutation),
                None => mutation(),
            }
        }
        "forwards.start" => {
            start_one(
                context,
                &field::<String>(&params, "id")?,
                &field::<String>(&params, "sessionId")?,
                None,
                None,
            )
            .await?;
            Ok(Value::Null)
        }
        "forwards.startMany" => batch::start(context, params).await,
        "forwards.stop" => {
            crate::services::forwarding::stop(app, &field::<String>(&params, "id")?).await?;
            Ok(Value::Null)
        }

        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

async fn start_one(
    context: &HostContext,
    id: &str,
    session_id: &str,
    expected_revision: Option<&str>,
    deadline: Option<tokio::time::Instant>,
) -> AppResult<()> {
    let app = &context.app;
    let state = app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    authorize(context, &["forwards.write"])?;
    let result = state
        .plugins
        .security
        .guard(
            &lease,
            crate::services::forwarding::prepare_checked(
                app,
                id,
                session_id,
                Some((context.id.clone(), context.generation)),
                expected_revision,
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
        .with_authorized(&lease, &["forwards.write"], || {
            if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                return Err(AppError::validation("plugin.timeout"));
            }
            prepared.commit()
        })
}

async fn start_managed(
    context: &HostContext,
    id: &str,
    revision: &str,
    deadline: Option<tokio::time::Instant>,
) -> AppResult<()> {
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    authorize(context, &["forwards.write"])?;
    let pending = state
        .plugins
        .security
        .guard(
            &lease,
            crate::services::forwarding::prepare_managed(
                &context.app,
                id,
                Some(revision),
                Some((context.id.clone(), context.generation)),
                None,
                None,
            ),
        )
        .await?;
    state
        .plugins
        .security
        .with_authorized(&lease, &["forwards.write"], || {
            if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                return Err(AppError::validation("plugin.timeout"));
            }
            pending.commit()
        })?;
    crate::ssh::session::announce_connection(&context.app);
    Ok(())
}
