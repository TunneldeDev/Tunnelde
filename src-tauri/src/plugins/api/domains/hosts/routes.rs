//! Revisioned plugin access to the same persisted route used by the host editor.
use crate::{
    db,
    error::{AppError, AppResult},
    network::{self, ConnectionRoute},
    plugins::{
        api::{encode, field, optional, HostContext},
        security::{admission, Lease},
    },
    services::credentials::lifecycle::host_incarnation,
    state::AppState,
};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

const READ: &[&str] = &["hosts.read"];
const WRITE: &[&str] = &["hosts.read", "hosts.write"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    host_id: String,
    revision: String,
    route: ConnectionRoute,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

fn revision_is_valid(revision: &str) -> bool {
    revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn snapshot(conn: &Connection, host_id: &str) -> AppResult<Snapshot> {
    db::hosts::find_host(conn, host_id)?;
    let incarnation = host_incarnation(conn, host_id)?;
    let route = network::route_at(conn, host_id)?;
    let data = serde_json::to_vec(&("tunnelde.host-route.v1", host_id, incarnation, &route))?;
    Ok(Snapshot {
        host_id: host_id.to_owned(),
        revision: format!("{:x}", Sha256::digest(data)),
        route,
    })
}

fn save(
    conn: &Connection,
    host_id: &str,
    expected: &str,
    route: &ConnectionRoute,
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<(Snapshot, bool)> {
    db::atomic(conn, |conn| {
        let current = snapshot(conn, host_id)?;
        if current.revision != expected {
            return Err(AppError::validation("network.routeChanged"));
        }
        admit()?;
        network::save_route_at(conn, host_id, route)?;
        let changed = current.route != *route;
        Ok((snapshot(conn, host_id)?, changed))
    })
}

pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let host_id: String = field(&params, "hostId")?;
    if !valid_id(&host_id) {
        return Err(AppError::validation("network.invalid"));
    }
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let app = context.app.clone();
    match method {
        "hosts.routes.get" | "hosts.routes.observe" => {
            let observe = method == "hosts.routes.observe";
            let revision: Option<String> = if observe {
                optional(&params, "revision")?
            } else {
                None
            };
            if revision
                .as_deref()
                .is_some_and(|value| !revision_is_valid(value))
            {
                return Err(AppError::validation("network.invalid"));
            }
            admission::blocking(move |cancel| {
                let state = app.state::<AppState>();
                let current = state.plugins.security.with_authorized_database(
                    &state.db,
                    &lease,
                    READ,
                    || cancel.check(),
                    |conn| snapshot(conn, &host_id),
                )?;
                if observe {
                    let changed = revision.as_ref() != Some(&current.revision);
                    Ok(json!({"revision": current.revision, "changed": changed,
                        "snapshot": changed.then_some(&current)}))
                } else {
                    encode(current)
                }
            })
            .await
        }
        "hosts.routes.save" => {
            let expected: String = field(&params, "expectedRevision")?;
            let route: ConnectionRoute = field(&params, "route")?;
            if !revision_is_valid(&expected)
                || route.proxy.len() > 128
                || !route.jump_hosts.iter().all(|id| valid_id(id))
            {
                return Err(AppError::validation("network.invalid"));
            }
            admission::blocking(move |cancel| {
                let state = app.state::<AppState>();
                let (current, changed) = state.plugins.security.with_authorized_database(
                    &state.db,
                    &lease,
                    WRITE,
                    || cancel.check(),
                    |conn| save(conn, &host_id, &expected, &route, || cancel.commit()),
                )?;
                if changed {
                    let _ = app.emit(
                        "plugin://domain-changed",
                        json!({"domain":"hosts","sessionId":null}),
                    );
                }
                encode(current)
            })
            .await
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

#[cfg(test)]
mod tests;
