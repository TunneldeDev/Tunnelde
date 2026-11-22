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
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            start_managed(
                context,
                origin.as_ref(),
                &field::<String>(&params, "id")?,
                &field::<String>(&params, "expectedRevision")?,
                None,
            )
            .await?;
            Ok(Value::Null)
        }
        "forwards.startManyManaged" => batch::start_managed(context, params).await,
        "forwards.automation.list" => {
            crate::platform::panel_windows::plugin_views::origin::check(
                crate::plugins::frontend::native::CallPolicy::StagedData,
            )?;
            let value = encode(crate::services::forwarding::automation::list(app)?);
            crate::platform::panel_windows::plugin_views::origin::check(
                crate::plugins::frontend::native::CallPolicy::StagedData,
            )?;
            value
        }
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
        "forwards.list" => {
            crate::platform::panel_windows::plugin_views::origin::check(
                crate::plugins::frontend::native::CallPolicy::StagedData,
            )?;
            let value = encode(crate::services::forwarding::list(app)?);
            crate::platform::panel_windows::plugin_views::origin::check(
                crate::plugins::frontend::native::CallPolicy::StagedData,
            )?;
            value
        }
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
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            start_one(
                context,
                origin.as_ref(),
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
            let id: String = field(&params, "id")?;
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            let check_origin = || {
                if let Some(origin) = &origin {
                    origin
                        .authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
                }
                Ok::<(), AppError>(())
            };
            check_origin()?;
            let revision = crate::services::forwarding::find(app, &id)?
                .ok_or_else(|| AppError::validation("forward.missing"))?
                .revision;
            crate::services::forwarding::stop_checked(app, &id, &revision, None).await?;
            check_origin()?;
            Ok(Value::Null)
        }

        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

async fn start_one(
    context: &HostContext,
    origin: Option<&crate::platform::panel_windows::plugin_views::origin::Origin>,
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
    let check = || {
        authorize(context, &["forwards.write"])?;
        if let Some(origin) = origin {
            origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
        }
        Ok::<(), AppError>(())
    };
    check()?;
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
    if let Err(error) = check() {
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
            check()?;
            if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                return Err(AppError::validation("plugin.timeout"));
            }
            prepared.commit()
        })?;
    check()
}

async fn start_managed(
    context: &HostContext,
    origin: Option<&crate::platform::panel_windows::plugin_views::origin::Origin>,
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
    let check = || {
        authorize(context, &["forwards.write"])?;
        if let Some(origin) = origin {
            origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
        }
        Ok::<(), AppError>(())
    };
    check()?;
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
            check()?;
            if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                return Err(AppError::validation("plugin.timeout"));
            }
            pending.commit()
        })?;
    check()?;
    crate::ssh::session::announce_connection(&context.app);
    Ok(())
}
