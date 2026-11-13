//! Fixed connection inputs, distinct from cosmetic host metadata. A route never
//! resolves a later hop from mutable storage after starting network I/O.
use super::*;
use crate::network::{ConnectionRoute, TcpRoute};
mod review;

pub(super) struct Node {
    pub host: Host,
    pub key: Option<String>,
}

pub(in super::super) struct Snapshot {
    pub(super) nodes: Vec<Node>,
    route: ConnectionRoute,
    pub(super) transport: TcpRoute,
}

fn changed() -> AppError {
    AppError::Ssh("ssh.connectionChanged".into())
}

fn same_destination(a: &Host, b: &Host) -> bool {
    a.id == b.id
        && a.host == b.host
        && a.port == b.port
        && a.username == b.username
        && a.auth_method == b.auth_method
        && a.key_path == b.key_path
}

fn capture_nodes(
    conn: &rusqlite::Connection,
    host: &Host,
    route: &ConnectionRoute,
) -> AppResult<Vec<Node>> {
    let mut seen = std::collections::HashSet::from([host.id.as_str()]);
    if route.jump_hosts.len() > 8 || route.jump_hosts.iter().any(|id| !seen.insert(id.as_str())) {
        return Err(AppError::validation("network.jumpCycle"));
    }
    route
        .jump_hosts
        .iter()
        .map(|id| db::hosts::find_host(conn, id))
        .chain(std::iter::once(Ok(host.clone())))
        .map(|host| {
            let host = host?;
            let key = db::known_hosts::find(conn, &host.host, host.port as i64)?
                .map(|key| key.fingerprint);
            Ok(Node { host, key })
        })
        .collect()
}

impl Snapshot {
    pub(in super::super) fn capture(app: &AppHandle, host: &Host) -> AppResult<Self> {
        let state = app.state::<AppState>();
        let (route, nodes) = state.db.with(|conn| {
            let route = crate::network::route_at(conn, &host.id)?;
            let nodes = capture_nodes(conn, host, &route)?;
            Ok((route, nodes))
        })?;
        let first = &nodes[0].host;
        let snapshot = Self {
            transport: TcpRoute::capture(app, &first.host, first.port, &route.proxy)?,
            nodes,
            route,
        };
        snapshot.verify(app)?;
        Ok(snapshot)
    }

    pub(in super::super) fn target(&self) -> &Host {
        &self.nodes.last().expect("route always has a target").host
    }

    pub(in super::super) fn jump_hosts(&self) -> Vec<Host> {
        self.nodes[..self.nodes.len() - 1]
            .iter()
            .map(|node| node.host.clone())
            .collect()
    }

    pub(in super::super) fn contains_host(&self, id: &str) -> bool {
        self.nodes.iter().any(|node| node.host.id == id)
    }

    pub(in super::super) fn revision(&self) -> String {
        review::revision(&self.nodes, &self.route, |digest| {
            self.transport.update_review(digest);
        })
    }

    /// Advance only the key the user approved, including saved aliases of the
    /// same endpoint. Other edits cannot be folded into a new review revision.
    pub(in super::super) fn approve_reviewed(
        &mut self,
        app: &AppHandle,
        info: &HostKeyInfo,
    ) -> AppResult<()> {
        self.approve(app, info)?;
        let observed = self
            .nodes
            .iter()
            .find(|node| node.host.id == info.host_id)
            .expect("approve checked observed host");
        let endpoint = (observed.host.host.clone(), observed.host.port);
        for node in &mut self.nodes {
            if (&node.host.host, node.host.port) == (&endpoint.0, endpoint.1) {
                node.key = Some(info.fingerprint.clone());
            }
        }
        self.verify(app)
    }

    fn verify_saved(&self, conn: &rusqlite::Connection) -> AppResult<()> {
        verify_configuration(conn, &self.target().id, &self.route, &self.nodes)
    }

    /// The database lock covers the final check and synchronous admission/write.
    /// Network operations never run inside this closure or retain its lock.
    pub(in super::super) fn with_current<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let first = &self.nodes[0].host;
        if TcpRoute::capture(app, &first.host, first.port, &self.route.proxy)
            .map_err(|_| changed())?
            != self.transport
        {
            return Err(changed());
        }
        for node in &self.nodes {
            if node
                .host
                .id
                .starts_with(crate::plugins::host_sources::PREFIX)
                && !same_destination(
                    &node.host,
                    &crate::services::hosts::resolve(app, &node.host.id).map_err(|_| changed())?,
                )
            {
                return Err(changed());
            }
        }
        app.state::<AppState>().db.with(|conn| {
            self.verify_saved(conn)?;
            operation(conn)
        })
    }

    pub(in super::super) fn verify(&self, app: &AppHandle) -> AppResult<()> {
        self.with_current(app, |_| Ok(()))
    }

    pub(in super::super) fn approve(&self, app: &AppHandle, info: &HostKeyInfo) -> AppResult<()> {
        // Never resolve an observed host ID to an edited address after probing.
        let node = self
            .nodes
            .iter()
            .find(|node| node.host.id == info.host_id)
            .ok_or_else(changed)?;
        self.verify(app)?;
        app.state::<AppState>().db.with(|conn| {
            self.verify_saved(conn)?;
            db::known_hosts::upsert(
                conn,
                &node.host.host,
                node.host.port as i64,
                &info.algorithm,
                &info.fingerprint,
            )
        })
    }
}

fn verify_configuration(
    conn: &rusqlite::Connection,
    target_id: &str,
    route: &ConnectionRoute,
    nodes: &[Node],
) -> AppResult<()> {
    if crate::network::route_at(conn, target_id)? != *route {
        return Err(changed());
    }
    verify_nodes(conn, nodes)
}

fn verify_nodes(conn: &rusqlite::Connection, nodes: &[Node]) -> AppResult<()> {
    for node in nodes {
        if !node
            .host
            .id
            .starts_with(crate::plugins::host_sources::PREFIX)
            && !same_destination(
                &node.host,
                &db::hosts::find_host(conn, &node.host.id).map_err(|_| changed())?,
            )
        {
            return Err(changed());
        }
        let key = db::known_hosts::find(conn, &node.host.host, node.host.port as i64)?
            .map(|key| key.fingerprint);
        if key != node.key {
            return Err(changed());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
