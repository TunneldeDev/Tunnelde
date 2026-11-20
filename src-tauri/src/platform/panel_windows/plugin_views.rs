//! Private native view authority. A frontend token alone is never a window,
//! document, panel lease, or incoming-offer capability.
use super::ownership::{Lease, Ownership};
use crate::plugins::{frontend::native::CallPolicy, security::Lease as PluginLease};
use std::{collections::HashMap, time::Instant};

type Result<T> = std::result::Result<T, &'static str>;
const MAX_VIEWS: usize = 64;
const MAX_CALLS: usize = 64;

#[derive(Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Target {
    Owned { lease: Lease },
    Staged { id: String },
}
#[derive(Clone)]
enum Authority {
    Owned(Lease),
    Staged { id: String, source: Lease },
}
struct View {
    window: String,
    document: String,
    plugin: PluginLease,
    panel_id: String,
    authority: Authority,
}
#[derive(Default)]
pub(super) struct Views {
    bindings: HashMap<String, View>,
    adapters: HashMap<String, adapters::Adapter>,
    ui: ui::Queue,
    // Accepted work is independent of the view's lifetime. Closing a token,
    // reloading a document or revoking a plugin cannot release a native effect.
    calls: HashMap<String, NativeCall>,
}
struct NativeCall {
    panel_id: String,
    fenced: bool,
}
impl Ownership {
    pub(super) fn native_view_target(
        &self,
        window: &str,
        document: &str,
        target: &Target,
        plugin_id: &str,
        view_id: &str,
        now: Instant,
    ) -> Result<String> {
        let expected = format!("plugin:{plugin_id}:{view_id}");
        let panel_id = match target {
            Target::Owned { lease } => {
                self.action(window, document, lease)?;
                lease.panel_id.clone()
            }
            Target::Staged { id } => self.staged(window, document, id, now)?.offer.lease.panel_id,
        };
        if panel_id != expected {
            return Err("plugin.frontend.undeclaredContribution");
        }
        Ok(expected)
    }
    pub(super) fn bind_native_view(
        &mut self,
        caller: (&str, &str),
        target: Target,
        plugin: PluginLease,
        view_id: &str,
        token: String,
        now: Instant,
    ) -> Result<()> {
        let (window, document) = caller;
        let panel_id =
            self.native_view_target(window, document, &target, &plugin.id, view_id, now)?;
        if self.native_views.bindings.len() >= MAX_VIEWS
            || self.native_views.bindings.contains_key(&token)
        {
            return Err("plugin.frontend.busy");
        }
        let authority = match target {
            Target::Owned { lease } => Authority::Owned(lease),
            Target::Staged { id } => Authority::Staged {
                source: self.staged(window, document, &id, now)?.offer.lease,
                id,
            },
        };
        self.native_views.bindings.insert(
            token,
            View {
                window: window.into(),
                document: document.into(),
                plugin,
                panel_id,
                authority,
            },
        );
        Ok(())
    }
    fn native_view(
        &self,
        window: &str,
        document: &str,
        token: &str,
        now: Instant,
    ) -> Result<&View> {
        self.authorize(window, document)?;
        let view = self
            .native_views
            .bindings
            .get(token)
            .ok_or("plugin.frontend.expired")?;
        if view.window != window || view.document != document {
            return Err("plugin.frontend.expired");
        }
        match &view.authority {
            Authority::Owned(lease) => {
                self.owned(window, document, lease)?;
            }
            Authority::Staged { id, source } => {
                if self.staged(window, document, id, now)?.offer.lease != *source {
                    return Err("plugin.frontend.expired");
                }
            }
        }
        Ok(view)
    }
    pub(super) fn native_view_owner(
        &self,
        window: &str,
        document: &str,
        token: &str,
        now: Instant,
    ) -> Result<PluginLease> {
        Ok(self
            .native_view(window, document, token, now)?
            .plugin
            .clone())
    }
    /// Final native authority for an actual domain transaction, including one
    /// resumed after a passive async wait. Never allows a staged destination.
    fn native_view_owned_lease(
        &self,
        window: &str,
        document: &str,
        token: &str,
        now: Instant,
    ) -> Result<Lease> {
        let view = self.native_view(window, document, token, now)?;
        let Authority::Owned(lease) = &view.authority else {
            return Err("plugin.frontend.viewNotCommitted");
        };
        self.resource_action(window, document, lease)?;
        Ok(lease.clone())
    }
    pub(super) fn native_view_resource(
        &self,
        window: &str,
        document: &str,
        token: &str,
        now: Instant,
    ) -> Result<PluginLease> {
        let view = self.native_view(window, document, token, now)?;
        let Authority::Owned(lease) = &view.authority else {
            return Err("plugin.frontend.viewNotCommitted");
        };
        self.resource_action(window, document, lease)?;
        Ok(view.plugin.clone())
    }
    pub(super) fn native_view_call(
        &mut self,
        window: &str,
        document: &str,
        token: &str,
        policy: CallPolicy,
        now: Instant,
    ) -> Result<(PluginLease, String)> {
        let view = self.native_view(window, document, token, now)?;
        match &view.authority {
            Authority::Owned(lease) => {
                self.action(window, document, lease)?;
            }
            Authority::Staged { .. } if !policy.staged() => {
                return Err("plugin.frontend.viewNotCommitted")
            }
            Authority::Staged { .. } => {}
        }
        let panel_id = view.panel_id.clone();
        let plugin = view.plugin.clone();
        if self.native_views.calls.len() >= MAX_CALLS
            || self
                .native_views
                .calls
                .values()
                .filter(|call| call.panel_id == panel_id)
                .count()
                >= 8
        {
            return Err("plugin.frontend.busy");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let fenced = policy.blocks_move();
        if fenced {
            self.relay_fence(&panel_id, &id, true)?;
        } else {
            self.native_view_resource(window, document, token, now)?;
        }
        self.native_views
            .calls
            .insert(id.clone(), NativeCall { panel_id, fenced });
        Ok((plugin, id))
    }
    pub(super) fn settle_native_view_call(&mut self, id: &str) {
        if let Some(call) = self.native_views.calls.remove(id) {
            if call.fenced {
                let _ = self.relay_fence(&call.panel_id, id, false);
            }
        }
    }
    pub(super) fn native_view_busy(&self, panel_id: &str) -> bool {
        self.native_views
            .calls
            .values()
            .any(|call| call.fenced && call.panel_id == panel_id)
    }
    pub(super) fn close_native_view(
        &mut self,
        window: &str,
        document: &str,
        token: &str,
    ) -> Result<bool> {
        // Close permits expired offers/leases, but never a different document's
        // token. A late cleanup cannot close its replacement or the singleton.
        self.authorize(window, document)?;
        let Some(view) = self.native_views.bindings.get(token) else {
            return Ok(false);
        };
        if view.window != window || view.document != document {
            return Err("plugin.frontend.expired");
        }
        self.native_views.bindings.remove(token);
        Ok(true)
    }
    pub(super) fn promote_native_views(
        &mut self,
        offer: &str,
        lease: &Lease,
        target_document: &str,
    ) {
        // Called only INSIDE commit's ownership transaction. Never infer this
        // from a missing offer plus coincidentally matching current ownership.
        for view in self.native_views.bindings.values_mut() {
            if view.document == target_document
                && view.window == lease.window_id
                && matches!(&view.authority, Authority::Staged { id, source } if id == offer && source.panel_id == lease.panel_id)
            {
                view.authority = Authority::Owned(lease.clone());
            }
        }
    }
    pub(super) fn prune_native_views(
        &mut self,
        now: Instant,
        live: impl Fn(&str, &PluginLease) -> bool,
    ) -> Vec<String> {
        let expired: Vec<_> = self
            .native_views
            .bindings
            .iter()
            .filter(|(token, view)| {
                self.native_view(&view.window, &view.document, token, now)
                    .is_err()
                    || !live(token, &view.plugin)
            })
            .map(|(token, _)| token.clone())
            .collect();
        for token in &expired {
            self.native_views.bindings.remove(token);
        }
        expired
    }
    pub(super) fn retire_native_views(&mut self, plugin: &str, before: u64) -> Vec<String> {
        let retired: Vec<_> = self
            .native_views
            .bindings
            .iter()
            .filter(|(_, v)| v.plugin.id == plugin && v.plugin.generation < before)
            .map(|(token, _)| token.clone())
            .collect();
        for token in &retired {
            self.native_views.bindings.remove(token);
        }
        retired
    }
}

pub(super) mod adapters;
pub(crate) mod gateway;
pub(crate) mod origin;
#[cfg(test)]
mod tests;
pub(crate) mod ui;
