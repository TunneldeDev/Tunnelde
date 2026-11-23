//! SOCKS5 domain routing, proxy groups and live runtime observation.
pub mod contract;
pub mod repository;
pub mod runtime;
pub mod socks;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use contract::{ProxyGroup, ProxyRoute, RevisionedGroup, RevisionedRoute};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

fn changed() -> AppError {
    AppError::validation("proxy.changed")
}

pub fn list_groups(app: &AppHandle, host_id: Option<&str>) -> AppResult<Vec<RevisionedGroup>> {
    let state = app.state::<AppState>();
    Ok(state
        .db
        .with(repository::list_groups_conn)?
        .into_iter()
        .filter(|entry| host_id.is_none_or(|id| entry.group.host_id == id))
        .collect())
}

pub fn list_routes(app: &AppHandle, group_id: Option<&str>) -> AppResult<Vec<RevisionedRoute>> {
    let state = app.state::<AppState>();
    Ok(state
        .db
        .with(repository::list_routes_conn)?
        .into_iter()
        .filter(|entry| group_id.is_none_or(|id| entry.route.group_id == id))
        .collect())
}

pub fn save_group(
    app: &AppHandle,
    mut input: contract::ProxyGroupInput,
    expected: Option<&str>,
) -> AppResult<RevisionedGroup> {
    input.auth_username = input.auth_username.trim().to_owned();
    input.listen_host = input.listen_host.trim().to_owned();
    let state = app.state::<AppState>();
    if !input.id.is_empty() && state.proxy.is_active(&input.id) {
        return Err(AppError::validation("proxy.stopBeforeEdit"));
    }
    let result = state.db.with(|conn| {
        crate::db::atomic(conn, |conn| {
            crate::db::hosts::find_host(conn, &input.host_id)?;
            let existing = if input.id.is_empty() {
                None
            } else {
                repository::find_group_conn(conn, &input.id)?
            };
            if expected.is_some_and(|revision| {
                existing
                    .as_ref()
                    .is_none_or(|entry| entry.revision != revision)
            }) {
                return Err(changed());
            }
            let auth_mode = input.auth_mode.trim().to_owned();
            let (auth_username, auth_salt, auth_verifier) = match auth_mode.as_str() {
                "none" => {
                    if !input.auth_username.trim().is_empty()
                        || input
                            .auth_password
                            .as_deref()
                            .is_some_and(|value| !value.is_empty())
                    {
                        return Err(AppError::validation("proxy.invalid"));
                    }
                    (String::new(), None, None)
                }
                "password" => {
                    let username = input.auth_username.clone();
                    if username.is_empty() {
                        return Err(AppError::validation("proxy.invalid"));
                    }
                    let salt = existing
                        .as_ref()
                        .and_then(|entry| entry.group.auth_salt.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    let same_username = existing
                        .as_ref()
                        .is_some_and(|entry| entry.group.auth_username == username);
                    let verifier = input
                        .auth_password
                        .as_deref()
                        .filter(|value| !value.is_empty())
                        .map(|password| repository::password_verifier(&username, password, &salt))
                        .or_else(|| {
                            same_username
                                .then(|| {
                                    existing
                                        .as_ref()
                                        .and_then(|entry| entry.group.auth_verifier.clone())
                                })
                                .flatten()
                        })
                        .ok_or_else(|| AppError::validation("proxy.passwordRequired"))?;
                    (username, Some(salt), Some(verifier))
                }
                _ => return Err(AppError::validation("proxy.invalid")),
            };
            let group = ProxyGroup {
                id: std::mem::take(&mut input.id),
                host_id: std::mem::take(&mut input.host_id),
                name: input.name.trim().to_owned(),
                listen_host: input.listen_host,
                listen_port: input.listen_port,
                auth_mode,
                auth_username,
                auth_password: None,
                auth_salt,
                auth_verifier,
                miss_policy: input.miss_policy,
                auto_start: input.auto_start,
                auto_retry: input.auto_retry,
            };
            repository::save_group_conn(conn, group, expected)
        })
    })?;
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"proxy"}),
    );
    Ok(result)
}

pub fn remove_group(app: &AppHandle, id: &str, expected: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    if state.proxy.is_active(id) {
        return Err(AppError::validation("proxy.stopBeforeEdit"));
    }
    state.db.with(|conn| {
        crate::db::atomic(conn, |conn| {
            repository::remove_group_conn(conn, id, expected)
        })
    })?;
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"proxy"}),
    );
    Ok(())
}

pub fn save_route(
    app: &AppHandle,
    route: ProxyRoute,
    expected: Option<&str>,
) -> AppResult<RevisionedRoute> {
    let state = app.state::<AppState>();
    let result = state.db.with(|conn| {
        crate::db::atomic(conn, |conn| {
            if let Some(existing) = repository::find_route_conn(conn, &route.id)? {
                if state.proxy.is_active(&existing.route.group_id)
                    || state.proxy.is_active(&route.group_id)
                {
                    return Err(AppError::validation("proxy.stopBeforeEdit"));
                }
            } else if state.proxy.is_active(&route.group_id) {
                return Err(AppError::validation("proxy.stopBeforeEdit"));
            }
            repository::save_route_conn(conn, route, expected)
        })
    })?;
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"proxy"}),
    );
    Ok(result)
}

pub fn remove_route(app: &AppHandle, id: &str, expected: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let route = state
        .db
        .with(|conn| repository::find_route_conn(conn, id))?
        .ok_or_else(changed)?;
    if state.proxy.is_active(&route.route.group_id) {
        return Err(AppError::validation("proxy.stopBeforeEdit"));
    }
    state.db.with(|conn| {
        crate::db::atomic(conn, |conn| {
            repository::remove_route_conn(conn, id, expected)
        })
    })?;
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"proxy"}),
    );
    Ok(())
}

pub fn ensure_default_group(app: &AppHandle, host_id: &str) -> AppResult<RevisionedGroup> {
    if let Some(group) = list_groups(app, Some(host_id))?.into_iter().next() {
        return Ok(group);
    }
    save_group(
        app,
        contract::ProxyGroupInput {
            id: String::new(),
            host_id: host_id.into(),
            name: "SOCKS5".into(),
            listen_host: "127.0.0.1".into(),
            listen_port: free_loopback_port()
                .ok_or_else(|| AppError::validation("proxy.bindFailed"))?,
            auth_mode: "none".into(),
            auth_username: String::new(),
            auth_password: None,
            miss_policy: contract::MissPolicy::Direct,
            auto_start: false,
            auto_retry: false,
        },
        None,
    )
}

fn free_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|address| address.port())
}

pub fn start_auto(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut retry_after = HashMap::<String, std::time::Instant>::new();
        let mut attempted = HashMap::<String, String>::new();
        loop {
            let groups = match list_groups(&app, None) {
                Ok(groups) => groups,
                Err(error) => {
                    tracing::warn!(%error, "Cannot load proxy groups for automatic start");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            let now = std::time::Instant::now();
            retry_after.retain(|id, at| {
                *at > now
                    && groups
                        .iter()
                        .any(|entry| entry.group.id == *id && entry.group.auto_start)
            });
            attempted.retain(|id, revision| {
                groups
                    .iter()
                    .any(|entry| entry.group.id == *id && entry.revision == *revision)
            });
            for group in groups.into_iter().filter(|entry| entry.group.auto_start) {
                let state = app.state::<crate::state::AppState>();
                if state.proxy.is_active(&group.group.id)
                    || state.proxy.is_paused(&group.group.id)
                    || retry_after
                        .get(&group.group.id)
                        .is_some_and(|at| *at > std::time::Instant::now())
                    || (!group.group.auto_retry
                        && attempted
                            .get(&group.group.id)
                            .is_some_and(|revision| revision == &group.revision))
                {
                    continue;
                }
                if contract::validate_group(&group.group).is_err() {
                    continue;
                }
                attempted.insert(group.group.id.clone(), group.revision.clone());
                let result =
                    runtime::start_owned(&app, &group.group.id, Some(&group.revision), None).await;
                if let Err(error) = result {
                    tracing::warn!(%error, group = %group.group.id, "Proxy group automatic start failed");
                    if group.group.auto_retry {
                        retry_after.insert(
                            group.group.id.clone(),
                            std::time::Instant::now() + std::time::Duration::from_secs(5),
                        );
                    }
                } else {
                    retry_after.remove(&group.group.id);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}
