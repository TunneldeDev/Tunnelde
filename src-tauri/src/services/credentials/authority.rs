//! Captured native mutation targets; no OS calls, UI tokens or secret payloads.
use super::{
    bindings::{self, Binding, Owner},
    lifecycle,
    native::Stamp,
};
use crate::{
    error::{AppError, AppResult},
    models::Host,
    network::ProxyProfile,
};
use rusqlite::Connection;

#[derive(Clone)]
pub(super) struct HostAuthority {
    pub(super) id: String,
    pub(super) binding: Binding,
    identity: Vec<u8>,
}

fn host_identity(conn: &Connection, host: &Host) -> AppResult<Vec<u8>> {
    let route = crate::network::route_at(conn, &host.id)?;
    let trust = crate::db::known_hosts::find(conn, &host.host, i64::from(host.port))?
        .map(|key| key.fingerprint);
    let jumps = route
        .jump_hosts
        .iter()
        .map(|id| {
            let hop = crate::db::hosts::find_host(conn, id)?;
            Ok(serde_json::json!([
                hop.id,
                hop.host,
                hop.port,
                hop.username,
                hop.auth_method,
                hop.key_path,
                lifecycle::host_incarnation(conn, id)?,
                crate::db::known_hosts::find(conn, &hop.host, i64::from(hop.port))?
                    .map(|key| key.fingerprint),
                lifecycle::trust_incarnation(conn, &hop.host, i64::from(hop.port))?
            ]))
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(serde_json::to_vec(&serde_json::json!([
        host.id,
        host.host,
        host.port,
        host.username,
        host.auth_method,
        host.key_path,
        route,
        jumps,
        trust,
        lifecycle::trust_incarnation(conn, &host.host, i64::from(host.port))?,
        lifecycle::host_incarnation(conn, &host.id)?,
        lifecycle::selection_authority(
            conn,
            &crate::db::settings::load_checked(conn)?.network,
            "ssh",
            Some(&route.proxy)
        )?
    ]))?)
}

impl HostAuthority {
    pub(super) fn capture(conn: &Connection, id: &str) -> AppResult<Self> {
        let host = crate::db::hosts::find_host(conn, id)?;
        Ok(Self {
            id: id.into(),
            binding: bindings::capture(conn, &Owner::host(id)?)?,
            identity: host_identity(conn, &host)?,
        })
    }
    pub(super) fn check(&self, conn: &Connection) -> AppResult<Stamp> {
        let host = crate::db::hosts::find_host(conn, &self.id)?;
        if host_identity(conn, &host)? != self.identity {
            return Err(AppError::validation("credentials.changed"));
        }
        Ok(Stamp::capture(&self.identity))
    }
}

pub(super) fn proxy_stamp(conn: &Connection, expected: &ProxyProfile) -> AppResult<Stamp> {
    let network = crate::db::settings::load_checked(conn)?.network;
    let actual = network
        .profiles
        .iter()
        .find(|p| p.id == expected.id)
        .ok_or_else(|| AppError::validation("network.proxyMissing"))?;
    let identity =
        |p: &ProxyProfile| serde_json::json!([p.id, p.protocol, p.host, p.port, p.username]);
    if identity(actual) != identity(expected) {
        return Err(AppError::validation("network.configurationChanged"));
    }
    Ok(Stamp::capture(&serde_json::to_vec(&serde_json::json!([
        identity(actual),
        lifecycle::proxy_incarnation(conn, &expected.id)?
    ]))?))
}

pub(super) struct ProxyAuthority {
    pub(super) profile: ProxyProfile,
    pub(super) binding: Binding,
    stamp: Stamp,
}
impl ProxyAuthority {
    pub(super) fn capture(conn: &Connection, profile: &ProxyProfile) -> AppResult<Self> {
        Ok(Self {
            profile: profile.clone(),
            binding: bindings::capture(conn, &Owner::proxy(&profile.id)?)?,
            stamp: proxy_stamp(conn, profile)?,
        })
    }
    pub(super) fn check(&self, conn: &Connection) -> AppResult<Stamp> {
        let current = proxy_stamp(conn, &self.profile)?;
        if current != self.stamp {
            return Err(AppError::validation("credentials.changed"));
        }
        Ok(current)
    }
}
