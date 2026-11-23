//! Independent SOCKS proxy contracts. Frozen port-forward DTOs are not reused.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

pub const MAX_GROUPS: usize = 512;
pub const MAX_ROUTES: usize = 4096;
pub const MAX_ROUTES_PER_GROUP: usize = 512;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissPolicy {
    #[default]
    Direct,
    Remote,
    Reject,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteMode {
    #[default]
    Group,
    Dedicated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyGroup {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub auth_mode: String,
    pub auth_username: String,
    #[serde(skip)]
    pub auth_password: Option<String>,
    #[serde(skip)]
    pub auth_salt: Option<String>,
    #[serde(skip)]
    pub auth_verifier: Option<String>,
    pub miss_policy: MissPolicy,
    pub auto_start: bool,
    pub auto_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionedGroup {
    #[serde(flatten)]
    pub group: ProxyGroup,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyGroupInput {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub auth_mode: String,
    #[serde(default)]
    pub auth_username: String,
    #[serde(default)]
    pub auth_password: Option<String>,
    pub miss_policy: MissPolicy,
    pub auto_start: bool,
    pub auto_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyRoute {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub mode: RouteMode,
    pub match_host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_port: Option<u16>,
    pub target_host: String,
    pub target_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionedRoute {
    #[serde(flatten)]
    pub route: ProxyRoute,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRuntime {
    pub group_id: String,
    pub host_id: String,
    pub session_id: String,
    pub socks_endpoint: String,
    pub active_connections: usize,
    pub exposure_warning: bool,
    pub started_at: i64,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConnection {
    pub id: String,
    pub group_id: String,
    pub route_id: Option<String>,
    pub source: String,
    pub target: String,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub started_at: i64,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunAttach {
    pub group_id: String,
    pub revision: String,
    pub socks_endpoint: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub routes: Vec<RevisionedRoute>,
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub(crate) fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '/' | '\\' | '@' | '#' | '?' | '[' | ']')
        })
}

fn loopback(value: &str) -> bool {
    value
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

/// Validate a durable group definition. A password group imported from a plain
/// export intentionally has no verifier yet; it remains invalid for runtime
/// start until the user supplies a password.
pub(crate) fn validate_group_definition(group: &ProxyGroup) -> AppResult<()> {
    group
        .listen_host
        .parse::<IpAddr>()
        .map_err(|_| AppError::validation("proxy.invalid"))?;
    let auth = match group.auth_mode.as_str() {
        "none" => {
            group.auth_username.is_empty()
                && group.auth_salt.is_none()
                && group.auth_verifier.is_none()
        }
        "password" => {
            !group.auth_username.trim().is_empty()
                && group.auth_username.len() <= 255
                && match (group.auth_salt.as_deref(), group.auth_verifier.as_deref()) {
                    (None, None) => true,
                    (Some(salt), Some(verifier)) => {
                        !salt.is_empty()
                            && verifier.len() == 64
                            && verifier.bytes().all(|byte| byte.is_ascii_hexdigit())
                    }
                    _ => false,
                }
        }
        _ => false,
    };
    if !valid_id(&group.id)
        || !valid_id(&group.host_id)
        || group.name.trim().is_empty()
        || group.name.chars().count() > 80
        || group.name.chars().any(char::is_control)
        || group.listen_port == 0
        || !auth
        || (!loopback(&group.listen_host) && group.auth_mode != "password")
    {
        return Err(AppError::validation("proxy.invalid"));
    }
    Ok(())
}

pub fn validate_group(group: &ProxyGroup) -> AppResult<()> {
    validate_group_definition(group)?;
    if group.auth_mode == "password" && (group.auth_salt.is_none() || group.auth_verifier.is_none())
    {
        return Err(AppError::validation("proxy.passwordRequired"));
    }
    Ok(())
}

pub(crate) fn route_validate_parts(route: &ProxyRoute) -> (bool, bool, bool, bool) {
    let matcher = route.match_host.trim();
    let cidr = matcher.parse::<ipnet::IpNet>().is_ok();
    let wildcard = matcher
        .strip_prefix("*.")
        .is_some_and(|suffix| !suffix.is_empty() && valid_host(suffix));
    let domain = valid_host(matcher);
    let dedicated = match route.mode {
        RouteMode::Group => true,
        RouteMode::Dedicated => {
            route
                .bind_host
                .as_deref()
                .is_some_and(|value| value.parse::<IpAddr>().is_ok())
                && route.bind_port.is_some_and(|port| port != 0)
        }
    };
    (domain, wildcard, cidr, dedicated)
}

pub fn validate_route(route: &ProxyRoute) -> AppResult<()> {
    let (domain, wildcard, cidr, dedicated) = route_validate_parts(route);
    if !valid_id(&route.id)
        || !valid_id(&route.group_id)
        || route.name.trim().is_empty()
        || route.name.chars().count() > 80
        || route.name.chars().any(char::is_control)
        || (!domain && !wildcard && !cidr)
        || route.match_port == Some(0)
        || !valid_host(&route.target_host)
        || route.target_port == 0
        || !dedicated
    {
        return Err(AppError::validation("proxy.invalid"));
    }
    Ok(())
}

/// Dedicated listeners are exposed independently of the group's listener. A
/// non-loopback bind therefore needs the same username/password protection.
pub(crate) fn validate_route_for_group(route: &ProxyRoute, group: &ProxyGroup) -> AppResult<()> {
    validate_route(route)?;
    if route.mode == RouteMode::Dedicated
        && route
            .bind_host
            .as_deref()
            .and_then(|host| host.parse::<IpAddr>().ok())
            .is_some_and(|address| !address.is_loopback())
        && (group.auth_mode != "password"
            || group.auth_salt.is_none()
            || group.auth_verifier.is_none())
    {
        return Err(AppError::validation("proxy.invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group() -> ProxyGroup {
        ProxyGroup {
            id: "group".into(),
            host_id: "host".into(),
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
        }
    }

    #[test]
    fn loopback_may_omit_auth_but_exposed_listeners_may_not() {
        assert!(validate_group(&group()).is_ok());
        let mut exposed = group();
        exposed.listen_host = "0.0.0.0".into();
        assert!(validate_group(&exposed).is_err());
        exposed.auth_mode = "password".into();
        exposed.auth_username = "user".into();
        exposed.auth_salt = Some("salt".into());
        exposed.auth_verifier = Some("a".repeat(64));
        assert!(validate_group(&exposed).is_ok());
    }

    #[test]
    fn pending_password_groups_are_valid_definitions_but_not_runtime_ready() {
        let mut pending = group();
        pending.auth_mode = "password".into();
        pending.auth_username = "user".into();
        assert!(validate_group_definition(&pending).is_ok());
        assert!(validate_group(&pending).is_err());
    }

    #[test]
    fn wildcard_and_cidr_routes_are_bounded() {
        let route = ProxyRoute {
            id: "route".into(),
            group_id: "group".into(),
            name: "Example".into(),
            mode: RouteMode::Group,
            match_host: "*.example.com".into(),
            match_port: Some(443),
            target_host: "gitlab.justalk.com".into(),
            target_port: 8080,
            bind_host: None,
            bind_port: None,
        };
        assert!(validate_route(&route).is_ok());
        let mut cidr = route.clone();
        cidr.match_host = "10.0.0.0/8".into();
        assert!(validate_route(&cidr).is_ok());
        let mut invalid = route;
        invalid.mode = RouteMode::Dedicated;
        assert!(validate_route(&invalid).is_err());
    }

    #[test]
    fn exposed_dedicated_listeners_require_group_authentication() {
        let group = group();
        let mut route = ProxyRoute {
            id: "route".into(),
            group_id: group.id.clone(),
            name: "Exposed".into(),
            mode: RouteMode::Dedicated,
            match_host: "example.com".into(),
            match_port: None,
            target_host: "example.com".into(),
            target_port: 443,
            bind_host: Some("0.0.0.0".into()),
            bind_port: Some(8443),
        };
        assert!(validate_route_for_group(&route, &group).is_err());
        route.bind_host = Some("127.0.0.1".into());
        assert!(validate_route_for_group(&route, &group).is_ok());
    }
}
