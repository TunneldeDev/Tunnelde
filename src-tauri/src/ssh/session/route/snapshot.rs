//! Fixed connection inputs, distinct from cosmetic host metadata. A route never
//! resolves a later hop from mutable storage after starting network I/O.
use super::*;
use crate::network::{ConnectionRoute, TcpRoute};
mod observation;
mod review;
pub(in crate::ssh::session) use observation::Observed;

#[derive(Clone)]
pub(super) struct Node {
    pub host: Host,
    pub key: Option<String>,
}

#[derive(Clone)]
pub(in super::super) struct Snapshot {
    pub(super) nodes: Vec<Node>,
    route: ConnectionRoute,
    pub(super) transport: TcpRoute,
    proxy: crate::network::proxy::Selected,
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
    pub(in super::super) async fn capture_background(
        app: &AppHandle,
        host_id: &str,
    ) -> AppResult<Self> {
        let app = app.clone();
        let host_id = host_id.to_owned();
        crate::services::credentials::inspect(move || {
            let host = crate::services::hosts::resolve(&app, &host_id)?;
            Self::capture(&app, &host)
        })
        .await
    }

    pub(in super::super) fn capture(app: &AppHandle, host: &Host) -> AppResult<Self> {
        let state = app.state::<AppState>();
        let (route, nodes, network) = state.db.with(|conn| {
            let (route, nodes) = capture_configuration(conn, host)?;
            Ok((route, nodes, db::settings::load_checked(conn)?.network))
        })?;
        // Reject an already-stale displayed host or revoked dynamic source
        // before transport capture can access a proxy credential. The DB guard
        // has ended; verification after OS access still checks concurrent edits.
        verify_dynamic(&nodes, |id| crate::services::hosts::resolve(app, id))?;
        let first = &nodes[0].host;
        let snapshot = Self {
            proxy: crate::network::proxy::Selected::capture(&network, "ssh", Some(&route.proxy))?,
            transport: TcpRoute::capture_with(
                &state.vault,
                &network,
                &first.host,
                first.port,
                &route.proxy,
            )?,
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

    /// Acquire a saved password off the runtime without retaining the DB lock.
    /// The worker revalidates the original review before and after the read;
    /// only a still-current value may reach authentication.
    pub(in super::super) async fn authentication(
        &self,
        app: &AppHandle,
        host: &Host,
        request: &SshConnectRequest,
    ) -> AppResult<SshConnectRequest> {
        self.verify_background(app).await?;
        let mut request = request.clone();
        if !matches!(host.auth_method.as_str(), "key" | "agent")
            && request
                .password
                .as_ref()
                .is_none_or(|value| value.is_empty())
            && !host.id.starts_with(crate::plugins::host_sources::PREFIX)
        {
            let reviewed = self.clone();
            let host_id = host.id.clone();
            request.password = crate::services::credentials::load_reviewed(
                app.clone(),
                host_id.clone(),
                move |app| {
                    if !reviewed.contains_host(&host_id) {
                        return Err(changed());
                    }
                    reviewed.verify(app)
                },
            )
            .await?;
            // Recheck after asynchronous delivery, before returning any value
            // to the route's next authentication step.
            self.verify_background(app).await?;
        }
        Ok(request)
    }

    pub(in super::super) fn revision(&self) -> String {
        review::revision(&self.nodes, &self.route, |digest| {
            self.transport.update_review(digest);
            self.proxy.update_review(digest);
        })
    }

    /// Advance only the key the user approved, including saved aliases of the
    /// same endpoint. Other edits cannot be folded into a new review revision.
    pub(in super::super) fn approve_reviewed_checked(
        &mut self,
        app: &AppHandle,
        info: &HostKeyInfo,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        self.approve_checked(app, info, check)?;
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
        verify_configuration(conn, &self.target().id, &self.route, &self.nodes)?;
        let network = db::settings::load_checked(conn)
            .map_err(|_| changed())?
            .network;
        let current =
            crate::network::proxy::Selected::capture(&network, "ssh", Some(&self.route.proxy))
                .map_err(|_| changed())?;
        if current != self.proxy {
            return Err(changed());
        }
        Ok(())
    }

    /// The database lock covers the final check and synchronous admission/write.
    /// Network operations never run inside this closure or retain its lock.
    pub(in super::super) fn with_current<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.observe(app)?.with_current(app, operation)
    }

    pub(in super::super) fn verify(&self, app: &AppHandle) -> AppResult<()> {
        self.with_current(app, |_| Ok(()))
    }

    pub(in super::super) async fn verify_background(&self, app: &AppHandle) -> AppResult<()> {
        let snapshot = self.clone();
        let app = app.clone();
        crate::services::credentials::checked(move |job| {
            snapshot.with_current(&app, |_| job.check())
        })
        .await
    }

    pub(in super::super) async fn approve_background(
        &self,
        app: &AppHandle,
        info: &HostKeyInfo,
    ) -> AppResult<()> {
        let snapshot = self.clone();
        let app = app.clone();
        let info = info.clone();
        crate::services::credentials::checked(move |job| {
            snapshot.approve_checked(&app, &info, || job.commit())
        })
        .await
    }

    fn approve_checked(
        &self,
        app: &AppHandle,
        info: &HostKeyInfo,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        // Never resolve an observed host ID to an edited address after probing.
        let node = self
            .nodes
            .iter()
            .find(|node| node.host.id == info.host_id)
            .ok_or_else(changed)?;
        self.verify(app)?;
        app.state::<AppState>().db.with(|conn| {
            self.verify_saved(conn)?;
            check()?;
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

fn capture_configuration(
    conn: &rusqlite::Connection,
    host: &Host,
) -> AppResult<(ConnectionRoute, Vec<Node>)> {
    let route = crate::network::route_at(conn, &host.id)?;
    let nodes = capture_nodes(conn, host, &route)?;
    verify_configuration(conn, &host.id, &route, &nodes)?;
    Ok((route, nodes))
}

fn verify_dynamic(
    nodes: &[Node],
    mut resolve: impl FnMut(&str) -> AppResult<Host>,
) -> AppResult<()> {
    for node in nodes {
        if node
            .host
            .id
            .starts_with(crate::plugins::host_sources::PREFIX)
            && !same_destination(&node.host, &resolve(&node.host.id).map_err(|_| changed())?)
        {
            return Err(changed());
        }
    }
    Ok(())
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
