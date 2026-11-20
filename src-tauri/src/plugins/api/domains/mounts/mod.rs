//! Mount RPCs share host-owned configuration, transports and operation receipts.
mod force;
mod legacy;
mod paths;
mod plans;
mod remote_paths;
use crate::{
    error::AppResult,
    plugins::{
        api::{authorize, encode, field, optional, HostContext},
        security::Lease,
    },
    services::{
        mounts::{
            configuration, repository,
            runtime::{self, Authority},
        },
        operations::{Budget, Errors},
    },
    state::AppState,
};
use serde_json::{json, Value};
use std::sync::LazyLock;
use tauri::Manager;

pub(super) fn lease(context: &HostContext) -> Lease {
    Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    }
}
fn configuration_method(method: &str) -> bool {
    matches!(
        method,
        "rules.snapshot"
            | "rules.list"
            | "rules.get"
            | "rules.validate"
            | "rules.save"
            | "rules.move"
            | "rules.copyHost"
            | "rules.export"
            | "rules.importPreview"
            | "rules.importApply"
            | "groups.list"
            | "groups.get"
            | "groups.validate"
            | "groups.save"
    )
}
async fn configured(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "mounts.configuration",
                busy: "mounts.operations.busy",
                cancelled: "mounts.operations.cancelled",
                failed: "mounts.operations.failed",
            },
        )
    });
    let context = context.clone();
    let method = method.to_owned();
    let write = configuration::writes(&method);
    let result = WORKERS
        .blocking(move |cancel| {
            let state = context.app.state::<AppState>();
            let lease = lease(&context);
            let mut params = Some(params);
            state.plugins.security.with_authorized_attempt(
                &lease,
                if write {
                    &["mounts.write"]
                } else {
                    &["mounts.read"]
                },
                || cancel.check(),
                || {
                    state.db.try_with(|conn| {
                        cancel.check()?;
                        if write {
                            cancel.commit()?;
                        }
                        let params = params.take().expect("one admitted configuration request");
                        if write {
                            crate::db::atomic(conn, |conn| {
                                configuration::call(&state.mount_runtime, conn, &method, params)
                            })
                        } else {
                            configuration::call(&state.mount_runtime, conn, &method, params)
                        }
                    })
                },
            )
        })
        .await?;
    Ok(result)
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let method = method.trim_start_matches("mounts.");
    let app = &context.app;
    let state = app.state::<AppState>();
    if configuration_method(method) {
        let write = configuration::writes(method);
        let value = configured(context, method, params).await?;
        if write {
            runtime::changed(app);
        }
        return Ok(value);
    }
    match method {
        "legacy.list" | "legacy.convert" | "legacy.dismiss" => {
            legacy::call(context, method, params).await
        }
        "dependencies.get" | "dependencies.refresh" => {
            let result = crate::mounts::dependencies().await?;
            authorize(context, &["mounts.read"])?;
            encode(result)
        }
        "dependencies.documentation" => {
            authorize(context, &["mounts.read"])?;
            crate::commands::open_external(
                app.clone(),
                crate::mounts::dependencies().await?.documentation,
            )?;
            Ok(Value::Null)
        }
        "paths.remote.browse"
        | "paths.remote.resolve"
        | "paths.local.pick"
        | "paths.local.validate"
        | "paths.conflicts" => paths::call(context, method, params).await,
        "connections.list" => {
            let host: Option<String> = optional(&params, "hostId")?;
            let statuses = state.mount_runtime.connection_states();
            encode(
                statuses
                    .into_iter()
                    .filter(|s| host.as_ref().is_none_or(|h| *h == s.host_id))
                    .collect::<Vec<_>>(),
            )
        }
        "connections.get" => {
            let id: String = field(&params, "groupId")?;
            encode(
                state
                    .mount_runtime
                    .connection_states()
                    .into_iter()
                    .find(|s| s.group_id == id),
            )
        }
        "groups.observe" | "connections.observe" => {
            observe(context, &params).await?;
            // An observation always reads current committed state after waking.
            if method == "groups.observe" {
                configured(
                    context,
                    "rules.snapshot",
                    json!({"hostId":field::<String>(&params,"hostId")?}),
                )
                .await
            } else {
                Ok(
                    json!({"revision":state.mount_runtime.revision(),"items":state.mount_runtime.connection_states()}),
                )
            }
        }
        "operations.list" => {
            let offset: usize = optional(&params, "offset")?.unwrap_or(0);
            let mut items = state.mount_runtime.operations.list();
            items.sort_by(|a, b| a.id.cmp(&b.id));
            Ok(
                json!({"total":items.len(),"items":items.into_iter().skip(offset).take(16).collect::<Vec<_>>()}),
            )
        }
        "operations.get" => encode(
            state
                .mount_runtime
                .operations
                .get(&field::<String>(&params, "id")?)?,
        ),
        "operations.observe" => {
            let id: String = field(&params, "id")?;
            let prior: Option<String> = optional(&params, "revision")?;
            let changed = state.mount_runtime.changed.notified();
            let info = state.mount_runtime.operations.get(&id)?;
            if prior.as_deref() == Some(&info.revision)
                && matches!(info.phase.as_str(), "pending" | "running")
            {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), changed).await;
            }
            authorize(context, &["mounts.read"])?;
            encode(state.mount_runtime.operations.get(&id)?)
        }
        "operations.cancel" => {
            let info = state
                .mount_runtime
                .operations
                .cancel(&field::<String>(&params, "id")?)?;
            runtime::changed(app);
            encode(info)
        }
        "runtime.open" | "runtime.reveal" => {
            let id: String = field(&params, "id")?;
            let runtime_id: String = field(&params, "runtimeId")?;
            let status = state
                .mount_runtime
                .rule_states()
                .into_iter()
                .find(|s| s.rule_id == id && s.runtime_id.as_deref() == Some(&runtime_id))
                .ok_or_else(repository::changed)?;
            let session = status.session_id.ok_or_else(repository::changed)?;
            crate::mounts::open_managed(
                app.clone(),
                runtime_id,
                session,
                optional(&params, "path")?,
                method == "runtime.reveal",
                Authority(Some(lease(context))),
            )
            .await?;
            Ok(Value::Null)
        }
        "runtime.requestForceUnmount" => force::call(context, params).await,
        name if plans::owns(name) => plans::call(context, name, params).await,
        _ => {
            crate::mounts::action(
                app.clone(),
                context.id.clone(),
                method.into(),
                params,
                Some(context.generation),
            )
            .await
        }
    }
}
async fn observe(context: &HostContext, params: &Value) -> AppResult<()> {
    let state = context.app.state::<AppState>();
    let waiting = state.mount_runtime.changed.notified();
    if let Some(expected) = optional::<String>(params, "revision")? {
        if !params.get("hostId").is_some() && state.mount_runtime.revision() == expected {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await;
            return authorize(context, &["mounts.read"]);
        }
        if state.db.with(repository::revision)? == expected
            && optional::<String>(params, "runtimeRevision")?.as_deref()
                == Some(&state.mount_runtime.revision())
        {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await;
        }
    }
    authorize(context, &["mounts.read"])
}
