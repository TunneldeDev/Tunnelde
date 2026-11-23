//! Experimental SOCKS proxy API. All writes recheck the original runtime lease.
use crate::{
    error::{AppError, AppResult},
    plugins::{
        api::{authorize, encode, field, optional, HostContext},
        security::Lease,
    },
    services::proxy,
};
use serde_json::Value;
use tauri::Manager;

fn lease(context: &HostContext) -> Lease {
    Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    }
}

fn origin() -> AppResult<()> {
    crate::platform::panel_windows::plugin_views::origin::check(
        crate::plugins::frontend::native::CallPolicy::OwnedData,
    )
}

/// Run one domain effect while the plugin policy lock remains held. The domain
/// functions are synchronous and perform only bounded local admission, so this
/// prevents a permission revocation from racing a completed response.
fn guarded<T>(
    context: &HostContext,
    permission: &str,
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    context
        .app
        .state::<crate::state::AppState>()
        .plugins
        .security
        .with_authorized(&lease(context), &[permission], || {
            origin()?;
            let result = operation()?;
            origin()?;
            Ok(result)
        })
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let tun = method == "proxy.tun.attach";
    let read = method.ends_with(".list");
    let permission = if tun {
        "proxy.tun"
    } else if read {
        "proxy.read"
    } else {
        "proxy.write"
    };
    authorize(context, &[permission])?;
    origin()?;
    let app = &context.app;
    let result = match method {
        "proxy.routes.saveForHost" => {
            let input = field(&params, "route")?;
            let expected = optional::<String>(&params, "expectedRevision")?;
            guarded(context, permission, || {
                encode(route_for_host(app, input, expected.as_deref())?)
            })
        }
        "proxy.groups.list" => guarded(context, permission, || {
            encode(proxy::list_groups(
                app,
                optional::<String>(&params, "hostId")?.as_deref(),
            )?)
        }),
        "proxy.groups.save" => {
            let group = field(&params, "group")?;
            let expected = optional::<String>(&params, "expectedRevision")?;
            guarded(context, permission, || {
                encode(proxy::save_group(app, group, expected.as_deref())?)
            })
        }
        "proxy.groups.remove" => guarded(context, permission, || {
            proxy::remove_group(
                app,
                &field::<String>(&params, "id")?,
                &field::<String>(&params, "expectedRevision")?,
            )?;
            Ok(Value::Null)
        }),
        "proxy.routes.list" => guarded(context, permission, || {
            encode(proxy::list_routes(
                app,
                optional::<String>(&params, "groupId")?.as_deref(),
            )?)
        }),
        "proxy.routes.save" => {
            let route = field(&params, "route")?;
            let expected = optional::<String>(&params, "expectedRevision")?;
            guarded(context, permission, || {
                encode(proxy::save_route(app, route, expected.as_deref())?)
            })
        }
        "proxy.routes.remove" => guarded(context, permission, || {
            proxy::remove_route(
                app,
                &field::<String>(&params, "id")?,
                &field::<String>(&params, "expectedRevision")?,
            )?;
            Ok(Value::Null)
        }),
        "proxy.runtime.list" => guarded(context, permission, || {
            encode(proxy::runtime::runtime(app)?)
        }),
        "proxy.runtime.start" => {
            let group_id = field::<String>(&params, "groupId")?;
            let expected = optional::<String>(&params, "expectedRevision")?;
            let runtime = context
                .app
                .state::<crate::state::AppState>()
                .plugins
                .security
                .guard(&lease(context), async {
                    origin()?;
                    proxy::runtime::start_owned(
                        app,
                        &group_id,
                        expected.as_deref(),
                        Some((context.id.clone(), context.generation)),
                    )
                    .await
                })
                .await?;
            authorize(context, &[permission])?;
            origin()?;
            encode(runtime)
        }
        "proxy.runtime.stop" => {
            let group_id = field::<String>(&params, "groupId")?;
            let expected = optional::<String>(&params, "expectedRevision")?;
            let runtime_id = optional::<String>(&params, "runtimeId")?;
            context
                .app
                .state::<crate::state::AppState>()
                .plugins
                .security
                .guard(&lease(context), async {
                    origin()?;
                    proxy::runtime::stop(app, &group_id, expected.as_deref(), runtime_id.as_deref())
                        .await
                })
                .await?;
            authorize(context, &[permission])?;
            origin()?;
            Ok(Value::Null)
        }
        "proxy.connections.list" => guarded(context, permission, || {
            encode(proxy::runtime::connections(
                app,
                optional::<String>(&params, "groupId")?.as_deref(),
            )?)
        }),
        "proxy.connections.close" => guarded(context, permission, || {
            proxy::runtime::close_connection(app, &field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }),
        "proxy.tun.attach" => guarded(context, permission, || {
            encode(proxy::runtime::attach(
                app,
                &field::<String>(&params, "groupId")?,
            )?)
        }),
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    };
    authorize(context, &[permission])?;
    origin()?;
    result
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RouteForHost {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub mode: crate::services::proxy::contract::RouteMode,
    pub match_host: String,
    #[serde(default)]
    pub match_port: Option<u16>,
    pub target_host: String,
    pub target_port: u16,
    #[serde(default)]
    pub bind_host: Option<String>,
    #[serde(default)]
    pub bind_port: Option<u16>,
}

pub(super) fn route_for_host(
    app: &tauri::AppHandle,
    input: RouteForHost,
    expected: Option<&str>,
) -> AppResult<crate::services::proxy::contract::RevisionedRoute> {
    let host = crate::services::hosts::resolve(app, &input.host_id)?;
    let group = proxy::ensure_default_group(app, &host.id)?;
    let route = crate::services::proxy::contract::ProxyRoute {
        id: input.id,
        group_id: group.group.id,
        name: input.name,
        mode: input.mode,
        match_host: input.match_host,
        match_port: input.match_port,
        target_host: input.target_host,
        target_port: input.target_port,
        bind_host: input.bind_host,
        bind_port: input.bind_port,
    };
    proxy::save_route(app, route, expected)
}
