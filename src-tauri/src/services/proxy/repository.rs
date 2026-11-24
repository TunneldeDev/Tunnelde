//! Durable proxy groups/routes. Secrets are stored as salted SHA-256 verifiers;
//! plaintext is never serialized, logged or returned by list APIs.
use super::contract::{
    validate_group, validate_group_definition, validate_route, ProxyGroup, ProxyRoute,
    RevisionedGroup, RevisionedRoute, MAX_GROUPS, MAX_ROUTES, MAX_ROUTES_PER_GROUP,
};
use crate::{
    error::{AppError, AppResult},
    models::now_ms,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

fn changed() -> AppError {
    AppError::validation("proxy.changed")
}
fn invalid() -> AppError {
    AppError::validation("proxy.invalid")
}
fn group_key(id: &str) -> String {
    format!("proxy-group:{id}")
}
fn group_version(id: &str) -> String {
    format!("proxy-group-version:{id}")
}
fn route_key(id: &str) -> String {
    format!("proxy-route:{id}")
}
fn route_version(id: &str) -> String {
    format!("proxy-route-version:{id}")
}

pub(crate) fn password_verifier(username: &str, password: &str, salt: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"tunnelde.proxy.socks-auth.v1\0");
    digest.update(salt.as_bytes());
    digest.update(b"\0");
    digest.update(username.as_bytes());
    digest.update(b"\0");
    digest.update(password.as_bytes());
    format!("{:x}", digest.finalize())
}

fn revision(raw: &str, stored: Option<String>) -> AppResult<String> {
    match stored {
        Some(value) => {
            let value: String = serde_json::from_str(&value)?;
            if value.is_empty() || value.len() > 128 {
                return Err(invalid());
            }
            Ok(value)
        }
        None => Ok(format!("legacy:{:x}", Sha256::digest(raw.as_bytes()))),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredGroup {
    id: String,
    host_id: String,
    name: String,
    listen_host: String,
    listen_port: u16,
    auth_mode: String,
    auth_username: String,
    #[serde(default)]
    auth_salt: Option<String>,
    #[serde(default)]
    auth_verifier: Option<String>,
    miss_policy: super::contract::MissPolicy,
    auto_start: bool,
    auto_retry: bool,
}

impl StoredGroup {
    pub(crate) fn from_public(group: &ProxyGroup) -> Self {
        Self {
            id: group.id.clone(),
            host_id: group.host_id.clone(),
            name: group.name.clone(),
            listen_host: group.listen_host.clone(),
            listen_port: group.listen_port,
            auth_mode: group.auth_mode.clone(),
            auth_username: group.auth_username.clone(),
            auth_salt: group.auth_salt.clone(),
            auth_verifier: group.auth_verifier.clone(),
            miss_policy: group.miss_policy,
            auto_start: group.auto_start,
            auto_retry: group.auto_retry,
        }
    }
    pub(crate) fn into_public(self) -> ProxyGroup {
        ProxyGroup {
            id: self.id,
            host_id: self.host_id,
            name: self.name,
            listen_host: self.listen_host,
            listen_port: self.listen_port,
            auth_mode: self.auth_mode,
            auth_username: self.auth_username,
            auth_password: None,
            auth_salt: self.auth_salt,
            auth_verifier: self.auth_verifier,
            miss_policy: self.miss_policy,
            auto_start: self.auto_start,
            auto_retry: self.auto_retry,
        }
    }
}

pub(crate) fn list_groups_conn(conn: &Connection) -> AppResult<Vec<RevisionedGroup>> {
    let mut stmt = conn.prepare(
        "SELECT r.value,v.value FROM settings r LEFT JOIN settings v ON v.key='proxy-group-version:' || substr(r.key,13) WHERE r.key LIKE 'proxy-group:%' AND r.key NOT LIKE 'proxy-group-version:%' ORDER BY r.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (raw, token) = row?;
        let group: StoredGroup = serde_json::from_str(&raw)?;
        let group = group.into_public();
        if group.auth_mode == "password"
            && (group.auth_salt.is_none() || group.auth_verifier.is_none())
        {
            // A plain import can intentionally omit verifier material. Such a
            // group is retained as configuration but is not runnable until the
            // user supplies a password.
            result.push(RevisionedGroup {
                revision: revision(&raw, token)?,
                group,
            });
            continue;
        }
        validate_group_definition(&group)?;
        result.push(RevisionedGroup {
            revision: revision(&raw, token)?,
            group,
        });
    }
    Ok(result)
}

pub(crate) fn list_routes_conn(conn: &Connection) -> AppResult<Vec<RevisionedRoute>> {
    let mut stmt = conn.prepare(
        "SELECT r.value,v.value FROM settings r LEFT JOIN settings v ON v.key='proxy-route-version:' || substr(r.key,13) WHERE r.key LIKE 'proxy-route:%' AND r.key NOT LIKE 'proxy-route-version:%' ORDER BY r.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (raw, token) = row?;
        let route: ProxyRoute = serde_json::from_str(&raw)?;
        validate_route(&route)?;
        result.push(RevisionedRoute {
            revision: revision(&raw, token)?,
            route,
        });
    }
    Ok(result)
}

pub(crate) fn find_group_conn(conn: &Connection, id: &str) -> AppResult<Option<RevisionedGroup>> {
    Ok(list_groups_conn(conn)?
        .into_iter()
        .find(|entry| entry.group.id == id))
}
pub(crate) fn find_route_conn(conn: &Connection, id: &str) -> AppResult<Option<RevisionedRoute>> {
    Ok(list_routes_conn(conn)?
        .into_iter()
        .find(|entry| entry.route.id == id))
}

fn put(conn: &Connection, key: &str, value: &impl serde::Serialize) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![key, serde_json::to_string(value)?, now_ms()],
    )?;
    Ok(())
}

pub(crate) fn save_group_conn(
    conn: &Connection,
    group: ProxyGroup,
    expected: Option<&str>,
) -> AppResult<RevisionedGroup> {
    save_group_conn_with(conn, group, expected, false)
}

/// Imported plain documents omit verifier material. Keep the group definition
/// so the UI can prompt for a password before the group becomes runnable.
pub(crate) fn save_group_conn_import(
    conn: &Connection,
    group: ProxyGroup,
    expected: Option<&str>,
) -> AppResult<RevisionedGroup> {
    save_group_conn_with(conn, group, expected, true)
}

fn save_group_conn_with(
    conn: &Connection,
    mut group: ProxyGroup,
    expected: Option<&str>,
    allow_pending_auth: bool,
) -> AppResult<RevisionedGroup> {
    if group.id.is_empty() {
        if expected.is_some() {
            return Err(changed());
        }
        group.id = uuid::Uuid::new_v4().to_string();
    }
    if allow_pending_auth {
        validate_group_definition(&group)?;
    } else {
        validate_group(&group)?;
    }
    crate::db::hosts::find_host(conn, &group.host_id)?;
    let current = find_group_conn(conn, &group.id)?;
    if expected.is_some_and(|expected| {
        current
            .as_ref()
            .is_none_or(|entry| entry.revision != expected)
    }) {
        return Err(changed());
    }
    if current.is_none() && list_groups_conn(conn)?.len() >= MAX_GROUPS {
        return Err(AppError::validation("proxy.groupLimit"));
    }
    let revision = uuid::Uuid::new_v4().to_string();
    put(
        conn,
        &group_key(&group.id),
        &StoredGroup::from_public(&group),
    )?;
    put(conn, &group_version(&group.id), &revision)?;
    let mut public = group;
    public.auth_salt = None;
    public.auth_verifier = None;
    Ok(RevisionedGroup {
        group: public,
        revision,
    })
}

pub(crate) fn save_route_conn(
    conn: &Connection,
    mut route: ProxyRoute,
    expected: Option<&str>,
) -> AppResult<RevisionedRoute> {
    if route.id.is_empty() {
        if expected.is_some() {
            return Err(changed());
        }
        route.id = uuid::Uuid::new_v4().to_string();
    }
    let group = find_group_conn(conn, &route.group_id)?
        .ok_or_else(|| AppError::validation("proxy.groupMissing"))?;
    super::contract::validate_route_for_group(&route, &group.group)?;
    let current = find_route_conn(conn, &route.id)?;
    if expected.is_some_and(|expected| {
        current
            .as_ref()
            .is_none_or(|entry| entry.revision != expected)
    }) {
        return Err(changed());
    }
    let routes = list_routes_conn(conn)?;
    if current.is_none()
        && (routes.len() >= MAX_ROUTES
            || routes
                .iter()
                .filter(|entry| entry.route.group_id == group.group.id)
                .count()
                >= MAX_ROUTES_PER_GROUP)
    {
        return Err(AppError::validation("proxy.routeLimit"));
    }
    let revision = uuid::Uuid::new_v4().to_string();
    put(conn, &route_key(&route.id), &route)?;
    put(conn, &route_version(&route.id), &revision)?;
    Ok(RevisionedRoute { route, revision })
}

pub(crate) fn remove_group_conn(conn: &Connection, id: &str, expected: &str) -> AppResult<()> {
    let current = find_group_conn(conn, id)?.ok_or_else(changed)?;
    if current.revision != expected {
        return Err(changed());
    }
    if list_routes_conn(conn)?
        .iter()
        .any(|entry| entry.route.group_id == id)
    {
        return Err(AppError::validation("proxy.groupNotEmpty"));
    }
    conn.execute("DELETE FROM settings WHERE key=?1", [group_key(id)])?;
    conn.execute("DELETE FROM settings WHERE key=?1", [group_version(id)])?;
    Ok(())
}

pub(crate) fn remove_route_conn(conn: &Connection, id: &str, expected: &str) -> AppResult<()> {
    let current = find_route_conn(conn, id)?.ok_or_else(changed)?;
    if current.revision != expected {
        return Err(changed());
    }
    conn.execute("DELETE FROM settings WHERE key=?1", [route_key(id)])?;
    conn.execute("DELETE FROM settings WHERE key=?1", [route_version(id)])?;
    Ok(())
}

pub(crate) fn export_at(
    conn: &Connection,
    selected_hosts: &std::collections::HashSet<String>,
) -> AppResult<(Vec<RevisionedGroup>, Vec<RevisionedRoute>)> {
    let groups: Vec<_> = list_groups_conn(conn)?
        .into_iter()
        .filter(|entry| selected_hosts.contains(&entry.group.host_id))
        .collect();
    let ids: std::collections::HashSet<_> =
        groups.iter().map(|entry| entry.group.id.as_str()).collect();
    let routes = list_routes_conn(conn)?
        .into_iter()
        .filter(|entry| ids.contains(entry.route.group_id.as_str()))
        .collect();
    Ok((groups, routes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::services::proxy::contract::{MissPolicy, RouteMode};

    fn host(conn: &Connection) -> String {
        crate::db::hosts::create_host(
            conn,
            &crate::models::HostInput {
                name: "Server".into(),
                group_id: None,
                host: "example.test".into(),
                port: Some(22),
                username: Some("user".into()),
                auth_method: Some("password".into()),
                key_path: None,
                favorite: false,
                color: None,
                tags: vec![],
                note: None,
            }
            .validate()
            .unwrap(),
        )
        .unwrap()
        .id
    }

    #[test]
    fn groups_and_routes_round_trip_without_exposing_verifier_fields() {
        let db = Database::in_memory().unwrap();
        db.with(|conn| {
            let host = host(conn);
            let salt = "salt".to_string();
            let verifier = password_verifier("user", "secret", &salt);
            let group = ProxyGroup {
                id: "group".into(),
                host_id: host,
                name: "SOCKS".into(),
                listen_host: "127.0.0.1".into(),
                listen_port: 1080,
                auth_mode: "password".into(),
                auth_username: "user".into(),
                auth_password: None,
                auth_salt: Some(salt),
                auth_verifier: Some(verifier.clone()),
                miss_policy: MissPolicy::Direct,
                auto_start: false,
                auto_retry: false,
            };
            let saved = save_group_conn(conn, group, None)?;
            assert!(saved.group.auth_verifier.is_none());
            assert_eq!(
                list_groups_conn(conn)?[0].group.auth_verifier.as_deref(),
                Some(verifier.as_str())
            );
            let route = ProxyRoute {
                id: "route".into(),
                group_id: saved.group.id.clone(),
                name: "GitLab".into(),
                mode: RouteMode::Group,
                match_host: "gitlab.justalk.com".into(),
                match_port: None,
                target_host: "gitlab.justalk.com".into(),
                target_port: 8080,
                bind_host: None,
                bind_port: None,
            };
            let saved_route = save_route_conn(conn, route, None)?;
            assert_eq!(list_routes_conn(conn)?.len(), 1);
            assert!(remove_group_conn(conn, &saved.group.id, &saved.revision).is_err());
            remove_route_conn(conn, &saved_route.route.id, &saved_route.revision)?;
            remove_group_conn(conn, &saved.group.id, &saved.revision)?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn stale_revision_never_overwrites() {
        let db = Database::in_memory().unwrap();
        db.with(|conn| {
            let group = ProxyGroup {
                id: "group".into(),
                host_id: host(conn),
                name: "SOCKS".into(),
                listen_host: "127.0.0.1".into(),
                listen_port: 1080,
                auth_mode: "none".into(),
                auth_username: String::new(),
                auth_password: None,
                auth_salt: None,
                auth_verifier: None,
                miss_policy: MissPolicy::Direct,
                auto_start: false,
                auto_retry: false,
            };
            let saved = save_group_conn(conn, group.clone(), None)?;
            let _next = save_group_conn(conn, group.clone(), Some(&saved.revision))?;
            assert!(save_group_conn(conn, group, Some(&saved.revision)).is_err());
            Ok(())
        })
        .unwrap();
    }
}
