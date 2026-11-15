//! Slow read-only observation precedes short pure final authority guards.
use super::*;

// An opaque native proof, never a WebView/plugin-supplied DTO.
pub(in crate::ssh::session) struct Observed(Snapshot);
impl Snapshot {
    pub(in crate::ssh::session) fn observe(&self, app: &AppHandle) -> AppResult<Observed> {
        let state = app.state::<AppState>();
        verify_dynamic(&self.nodes, |id| crate::services::hosts::resolve(app, id))?;
        let network = state.db.with(|conn| {
            self.verify_saved(conn)?;
            Ok(db::settings::load_checked(conn)?.network)
        })?;
        let first = &self.nodes[0].host;
        // No database, recovery metadata, connection or registry lock spans OS access.
        let transport = TcpRoute::capture_with(
            &state.vault,
            &network,
            &first.host,
            first.port,
            &self.route.proxy,
        )
        .map_err(|_| changed())?;
        if transport != self.transport {
            return Err(changed());
        }
        let observed = Observed(self.clone());
        observed.with_current(app, |_| Ok(()))?;
        Ok(observed)
    }
    pub(in crate::ssh::session) async fn observe_background(
        &self,
        app: &AppHandle,
    ) -> AppResult<Observed> {
        let snapshot = self.clone();
        let app = app.clone();
        crate::services::credentials::inspect(move || snapshot.observe(&app)).await
    }
}
impl Observed {
    pub(in crate::ssh::session) fn with_current<T>(
        &self,
        app: &AppHandle,
        effect: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        verify_dynamic(&self.0.nodes, |id| crate::services::hosts::resolve(app, id))?;
        app.state::<AppState>().db.with(|conn| {
            self.0.verify_saved(conn)?;
            effect(conn)
        })
    }

    pub(in crate::ssh::session) fn approve(
        mut self,
        app: &AppHandle,
        info: &HostKeyInfo,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<Snapshot> {
        verify_dynamic(&self.0.nodes, |id| crate::services::hosts::resolve(app, id))?;
        app.state::<AppState>()
            .db
            .with(|conn| self.0.approve_at(conn, info, check))?;
        Ok(self.0)
    }
}

impl Snapshot {
    /// Key publication and native review advance share one short database guard.
    /// No OS credential lookup or network operation is allowed in this boundary.
    pub(super) fn approve_at(
        &mut self,
        conn: &rusqlite::Connection,
        info: &HostKeyInfo,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        self.verify_saved(conn)?;
        let node = self
            .nodes
            .iter()
            .find(|node| node.host.id == info.host_id)
            .ok_or_else(changed)?;
        let endpoint = (node.host.host.clone(), node.host.port);
        check()?;
        db::known_hosts::upsert(
            conn,
            &endpoint.0,
            endpoint.1 as i64,
            &info.algorithm,
            &info.fingerprint,
        )?;
        for node in &mut self.nodes {
            if (&node.host.host, node.host.port) == (&endpoint.0, endpoint.1) {
                node.key = Some(info.fingerprint.clone());
            }
        }
        self.verify_saved(conn)
    }
}
