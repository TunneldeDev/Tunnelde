//! In-memory view ownership, independent of SSH/plugin resource lifetimes.
//! Callers derive window labels from native IPC; never accept a label as identity.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

pub(super) fn transferable(id: &str) -> bool {
    matches!(id, "connections" | "tasks" | "output" | "knownHosts")
}

// "plugin:" + a 128-byte plugin ID + ":" + a 128-byte view ID.
// IDs are identities, never truncate them to make a transport limit fit.
pub(super) const MAX_PANEL_ID_BYTES: usize = 7 + 128 + 1 + 128;
pub(super) fn valid_panel_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_PANEL_ID_BYTES && !id.contains('\0')
}

pub(super) const MAIN: &str = "main";
const MAX_WINDOWS: usize = 16;
const MAX_PANELS: usize = 128;
const MAX_TRANSFERS: usize = 32;
const MAX_STATE_BYTES: usize = 1024 * 1024;
const TRANSFER_TTL: Duration = Duration::from_secs(15);
const DRAG_TTL: Duration = Duration::from_secs(30);
type Result<T> = std::result::Result<T, &'static str>;
fn token() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Lease {
    pub panel_id: String,
    pub window_id: String,
    pub generation: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowInfo {
    pub id: String,
    pub ready: bool,
    pub closing: bool,
}
struct Document {
    id: String,
    ready: bool,
    closing: bool,
}
pub(super) struct Panel {
    pub(super) lease: Lease,
    pub(super) presentation: Option<super::presentation::LayoutMetadata>,
    blocked: bool,
    // Document-local consent only; unlike admitted effects, retires on reload.
    interactions: HashMap<String, String>,
    // Contains user drafts. Deliberately no Debug/Serialize on internal records;
    // never persist or include snapshots in public events/discovery/list replies.
    checkpoint: Value,
    checkpoint_revision: u64,
    pub(super) model: Value,
    pub(super) model_document: String,
    pub(super) model_publisher: String,
    pub(super) model_revision: u64,
    pub(super) native_actions: HashSet<String>,
}
pub(super) struct Transfer {
    id: String,
    lease: Lease,
    source_document: String,
    pub(super) target_window: String,
    pub(super) target_document: String,
    pub(super) presentation: Option<super::presentation::LayoutMetadata>,
    state: Value,
    deadline: Instant,
    ready: bool,
}
struct DragGrant {
    lease: Lease,
    document: String,
    deadline: Instant,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Offer {
    pub id: String,
    pub lease: Lease,
    pub target_window: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StagedView {
    pub offer: Offer,
    pub state: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferInfo {
    pub offer: Offer,
    pub ready: bool,
}
#[derive(Default)]
pub(super) struct Ownership {
    generation: u64,
    pub(super) moves: HashMap<String, super::moves::PendingMove>,
    pub(super) actions: HashMap<String, super::actions::PendingAction>,
    // Unknown outcomes after coordinator document loss. These are not released
    // by result TTL, source retirement, auth unblock, or a reused panel ID.
    pub(super) interrupted: HashMap<String, String>,
    windows: HashMap<String, Document>,
    destroying: HashSet<String>,
    pub(super) panels: HashMap<String, Panel>,
    pub(super) transfers: HashMap<String, Transfer>,
    pub(super) preview_placeholder: Option<super::presentation::LayoutMetadata>,
    pub(super) presentation_jobs: HashMap<String, super::presentation_jobs::PendingPresentation>,
    drags: HashMap<String, DragGrant>,
    pub(super) native_views: super::plugin_views::Views,
}
impl Ownership {
    /// The native builder registers a window before a WebView exists. Only the
    /// host issues document identities; a reload invalidates every old caller.
    pub fn register(&mut self, window: &str) -> Result<String> {
        if window.is_empty() || window.len() > 128 {
            return Err("invalid window");
        }
        if !self.windows.contains_key(window) && self.windows.len() >= MAX_WINDOWS {
            return Err("window limit");
        }
        self.retire_document_actions(window);
        self.retire_presentation_document(window);
        if window == MAIN {
            self.preview_placeholder = None;
        }
        self.save_pending_source(window);
        self.cancel_window_transfers(window);
        let document = token();
        self.windows.insert(
            window.into(),
            Document {
                id: document.clone(),
                ready: false,
                closing: false,
            },
        );
        self.drags
            .retain(|_, grant| grant.lease.window_id != window);
        for panel in self
            .panels
            .values_mut()
            .filter(|panel| panel.lease.window_id == window)
        {
            self.generation += 1;
            panel.lease.generation = self.generation;
            panel.checkpoint_revision = 0;
            panel.presentation = None;
            panel.interactions.clear();
        }
        Ok(document)
    }
    pub fn document(&self, window: &str) -> Option<&str> {
        self.windows
            .get(window)
            .map(|document| document.id.as_str())
    }
    pub fn authorize(&self, window: &str, document: &str) -> Result<()> {
        if self
            .windows
            .get(window)
            .is_some_and(|owner| owner.id == document)
        {
            Ok(())
        } else {
            Err("stale window document")
        }
    }
    pub fn ready(&mut self, window: &str, document: &str) -> Result<()> {
        self.authorize(window, document)?;
        self.windows.get_mut(window).unwrap().ready = true;
        Ok(())
    }
    pub fn windows(&self) -> Vec<WindowInfo> {
        let mut list: Vec<_> = self
            .windows
            .iter()
            .map(|(id, doc)| WindowInfo {
                id: id.clone(),
                ready: doc.ready,
                closing: doc.closing,
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }
    pub fn leases(&self) -> Vec<Lease> {
        let mut list: Vec<_> = self
            .panels
            .values()
            .map(|panel| panel.lease.clone())
            .collect();
        list.sort_by(|a, b| a.panel_id.cmp(&b.panel_id));
        list
    }
    pub fn offers(&self, window: &str, document: &str) -> Result<Vec<TransferInfo>> {
        self.authorize(window, document)?;
        let mut offers: Vec<_> = self
            .transfers
            .values()
            .filter(|pending| {
                window == MAIN
                    || pending.lease.window_id == window
                    || pending.target_window == window
            })
            .map(|pending| TransferInfo {
                offer: Offer {
                    id: pending.id.clone(),
                    lease: pending.lease.clone(),
                    target_window: pending.target_window.clone(),
                },
                ready: pending.ready,
            })
            .collect();
        offers.sort_by(|a, b| a.offer.id.cmp(&b.offer.id));
        Ok(offers)
    }
    pub fn has_satellites(&self) -> bool {
        self.windows.keys().any(|id| id != MAIN)
    }
    pub(super) fn main(&self, window: &str, document: &str) -> Result<()> {
        self.authorize(window, document)?;
        if window != MAIN {
            return Err("coordinator required");
        }
        Ok(())
    }
    /// Creating a destination is a presentation capability, not a general
    /// application proxy. Satellites must prove an exact, interactive adapter
    /// lease; an old document or another window's panel cannot spawn windows.
    pub fn authorize_creation(
        &self,
        window: &str,
        document: &str,
        lease: Option<&Lease>,
    ) -> Result<()> {
        self.authorize(window, document)?;
        if let Some(lease) = lease {
            self.action(window, document, lease)?;
            let panel = self.owned(window, document, lease)?;
            if !self.transferable(&lease.panel_id)
                || panel.blocked
                || !panel.interactions.is_empty()
                || !panel.native_actions.is_empty()
            {
                return Err("panel interaction in progress");
            }
        } else {
            self.main(window, document)?;
        }
        Ok(())
    }
    pub(super) fn authorize_move_fence(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        id: &str,
    ) -> Result<()> {
        let panel = self.owned(window, document, lease)?;
        if panel.blocked
            || !panel.interactions.is_empty()
            || panel.native_actions.len() != 1
            || !panel.native_actions.contains(id)
        {
            return Err("panel interaction in progress");
        }
        Ok(())
    }
    pub fn add_panel(&mut self, window: &str, document: &str, panel_id: &str) -> Result<Lease> {
        self.main(window, document)?;
        if !valid_panel_id(panel_id) || self.panels.len() >= MAX_PANELS {
            return Err("invalid panel");
        }
        if self.panels.contains_key(panel_id) {
            return Err("panel already registered");
        }
        self.generation += 1;
        let lease = Lease {
            panel_id: panel_id.into(),
            window_id: MAIN.into(),
            generation: self.generation,
        };
        self.panels.insert(
            panel_id.into(),
            Panel {
                lease: lease.clone(),
                presentation: None,
                blocked: false,
                interactions: HashMap::new(),
                checkpoint: Value::Null,
                checkpoint_revision: 0,
                model: Value::Null,
                model_document: String::new(),
                model_publisher: String::new(),
                model_revision: 0,
                native_actions: HashSet::new(),
            },
        );
        Ok(lease)
    }
    pub(super) fn owned(&self, window: &str, document: &str, lease: &Lease) -> Result<&Panel> {
        self.authorize(window, document)?;
        self.panels
            .get(&lease.panel_id)
            .filter(|panel| panel.lease == *lease && lease.window_id == window)
            .ok_or("stale panel owner")
    }
    pub fn action(&self, window: &str, document: &str, lease: &Lease) -> Result<()> {
        self.owned(window, document, lease)?;
        if self.panel_interrupted(&lease.panel_id) {
            return Err("panels.actionInterrupted");
        }
        if !self.windows[window].ready
            || self.destroying.contains(window)
            || self.windows[window].closing
            || self
                .transfers
                .values()
                .any(|pending| pending.lease.panel_id == lease.panel_id)
        {
            return Err("panel is frozen");
        }
        Ok(())
    }
    pub(super) fn resource_action(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
    ) -> Result<()> {
        self.action(window, document, lease)?;
        if self.panels[&lease.panel_id].blocked {
            return Err("panel interaction in progress");
        }
        Ok(())
    }
    pub fn remove_panel(&mut self, window: &str, document: &str, panel_id: &str) -> Result<()> {
        self.main(window, document)?;
        if self.native_view_busy(panel_id) {
            return Err("panel interaction in progress");
        }
        self.remove_presentation_panel(panel_id)?;
        self.retire_panel_actions(panel_id);
        self.retire_panel_moves(panel_id);
        self.panels.remove(panel_id).ok_or("panel not found")?;
        self.remove_plugin_adapter(panel_id);
        self.transfers
            .retain(|_, pending| pending.lease.panel_id != panel_id);
        self.drags
            .retain(|_, grant| grant.lease.panel_id != panel_id);
        Ok(())
    }
    /// Retired factory state is never restored into a replacement runtime.
    /// Retain actual-effect fences until settlement; revocation is not rollback.
    pub(super) fn reset_plugin_panel(&mut self, panel_id: &str) {
        self.retire_panel_moves(panel_id);
        // Cancel unadmitted presentation reservations; preserve an accepted
        // source UI effect until its exact document finalizes or disappears.
        let _ = self.remove_presentation_panel(panel_id);
        self.transfers
            .retain(|_, offer| offer.lease.panel_id != panel_id);
        self.drags
            .retain(|_, grant| grant.lease.panel_id != panel_id);
        if let Some(panel) = self.panels.get_mut(panel_id) {
            self.generation += 1;
            panel.lease.generation = self.generation;
            panel.checkpoint = Value::Null;
            panel.checkpoint_revision = 0;
            panel.presentation = None;
            panel.model = Value::Null;
            panel.model_document.clear();
            panel.model_publisher.clear();
            panel.model_revision += 1;
        }
    }
    pub(super) fn validate_state(state: &Value) -> Result<()> {
        if serde_json::to_vec(state)
            .map_err(|_| "invalid view state")?
            .len()
            > MAX_STATE_BYTES
        {
            return Err("view state limit");
        }
        Ok(())
    }
    pub fn checkpoint(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        revision: u64,
        state: Value,
    ) -> Result<()> {
        self.owned(window, document, lease)?;
        Self::validate_state(&state)?;
        if self
            .transfers
            .values()
            .any(|pending| pending.lease.panel_id == lease.panel_id)
        {
            return Err("panel transfer pending");
        }
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        if revision <= panel.checkpoint_revision {
            return Err("stale view checkpoint");
        }
        panel.checkpoint_revision = revision;
        panel.checkpoint = state;
        Ok(())
    }
    /// Read only the caller's current view. A destination must use staged() and
    /// acknowledge readiness before it acquires any action authority.
    pub fn view(&self, window: &str, document: &str, lease: &Lease) -> Result<Value> {
        Ok(self.owned(window, document, lease)?.checkpoint.clone())
    }
    pub(super) fn relay_fence(&mut self, panel_id: &str, id: &str, busy: bool) -> Result<()> {
        let Some(panel) = self.panels.get_mut(panel_id) else {
            return if busy { Err("panel not found") } else { Ok(()) };
        };
        if busy {
            if panel.blocked {
                return Err("panel interaction in progress");
            }
            panel.native_actions.insert(id.into());
        } else {
            panel.native_actions.remove(id);
        }
        Ok(())
    }
    /// Obtain before mounting consent UI or starting any credential effects.
    /// Opaque, independently released guards prevent overlapping dialogs from
    /// accidentally unblocking each other. They never enter public snapshots.
    pub fn begin_interaction(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
    ) -> Result<String> {
        self.action(window, document, lease)?;
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        if panel.blocked || panel.interactions.len() >= 16 {
            return Err("panel interaction in progress");
        }
        let id = token();
        panel.interactions.insert(id.clone(), document.into());
        self.drags
            .retain(|_, grant| grant.lease.panel_id != lease.panel_id);
        Ok(id)
    }
    pub(super) fn require_interaction(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        id: &str,
    ) -> Result<()> {
        self.owned(window, document, lease)?;
        if self.panels[&lease.panel_id]
            .interactions
            .get(id)
            .is_none_or(|owner| owner != document)
        {
            return Err("invalid interaction owner");
        }
        Ok(())
    }
    pub fn end_interaction(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        id: &str,
    ) -> Result<()> {
        self.owned(window, document, lease)?;
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        if panel
            .interactions
            .get(id)
            .is_some_and(|owner| owner != document)
        {
            return Err("invalid interaction owner");
        }
        panel.interactions.remove(id);
        Ok(())
    }
    pub fn block(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
        blocked: bool,
    ) -> Result<()> {
        self.main(window, document)?;
        let panel = self.panels.get_mut(panel_id).ok_or("panel not found")?;
        panel.blocked = blocked;
        if blocked {
            self.retire_panel_moves(panel_id);
            self.transfers
                .retain(|_, transfer| transfer.lease.panel_id != panel_id);
            self.drags
                .retain(|_, grant| grant.lease.panel_id != panel_id);
        }
        Ok(())
    }
    pub fn prepare(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        target: &str,
        state: Value,
        now: Instant,
    ) -> Result<Offer> {
        self.expire(now);
        let panel = self.owned(window, document, lease)?;
        if panel.blocked
            || !panel.interactions.is_empty()
            || !panel.native_actions.is_empty()
            || self.panel_interrupted(&lease.panel_id)
        {
            return Err("panel interaction in progress");
        }
        Self::validate_state(&state)?;
        if !self.windows[window].ready || (self.windows[window].closing && target != MAIN) {
            return Err("source unavailable");
        }
        if target == window {
            return Err("same window");
        }
        if self.destroying.contains(target) || self.destroying.contains(window) {
            return Err("window closing");
        }
        let destination = self
            .windows
            .get(target)
            .filter(|doc| doc.ready && !doc.closing)
            .ok_or("destination unavailable")?;
        if self.transfers.len() >= MAX_TRANSFERS {
            return Err("transfer limit");
        }
        if self
            .transfers
            .values()
            .any(|pending| pending.lease.panel_id == lease.panel_id)
        {
            return Err("panel transfer pending");
        }
        let offer = Offer {
            id: token(),
            lease: lease.clone(),
            target_window: target.into(),
        };
        self.transfers.insert(
            offer.id.clone(),
            Transfer {
                id: offer.id.clone(),
                lease: lease.clone(),
                source_document: document.into(),
                target_window: target.into(),
                target_document: destination.id.clone(),
                presentation: None,
                state,
                deadline: now + TRANSFER_TTL,
                ready: false,
            },
        );
        self.drags
            .retain(|_, grant| grant.lease.panel_id != lease.panel_id);
        Ok(offer)
    }
    pub(super) fn discard_move_offer(&mut self, id: &str) {
        self.transfers.remove(id);
    }
    pub(super) fn move_offer_exists(&self, id: &str, now: Instant) -> bool {
        self.pending(id, now).is_ok()
    }
    pub(super) fn pending(&self, id: &str, now: Instant) -> Result<&Transfer> {
        let pending = self
            .transfers
            .get(id)
            .filter(|pending| pending.deadline > now)
            .ok_or("transfer expired")?;
        self.owned(
            &pending.lease.window_id,
            &pending.source_document,
            &pending.lease,
        )?;
        self.authorize(&pending.target_window, &pending.target_document)?;
        Ok(pending)
    }
    pub fn staged(
        &self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<StagedView> {
        self.authorize(window, document)?;
        let pending = self.pending(id, now)?;
        if pending.target_window != window || pending.target_document != document {
            return Err("not transfer destination");
        }
        Ok(StagedView {
            offer: Offer {
                id: pending.id.clone(),
                lease: pending.lease.clone(),
                target_window: window.into(),
            },
            state: pending.state.clone(),
        })
    }
    pub fn acknowledge(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<()> {
        self.staged(window, document, id, now)?;
        self.transfers.get_mut(id).unwrap().ready = true;
        Ok(())
    }
    /// Only the singleton coordinator commits. A ready destination is not a
    /// resource owner until this atomic generation change succeeds.
    pub fn commit(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<Lease> {
        self.main(window, document)?;
        let pending = self.pending(id, now)?;
        if !pending.ready {
            return Err("destination not ready");
        }
        if self.panels[&pending.lease.panel_id].blocked
            || !self.panels[&pending.lease.panel_id].interactions.is_empty()
            || !self.panels[&pending.lease.panel_id]
                .native_actions
                .is_empty()
        {
            return Err("panel interaction in progress");
        }
        let pending = self.transfers.remove(id).unwrap();
        let panel = self.panels.get_mut(&pending.lease.panel_id).unwrap();
        panel.lease.window_id = pending.target_window;
        self.generation += 1;
        panel.lease.generation = self.generation;
        panel.checkpoint_revision = 0;
        panel.checkpoint = pending.state;
        panel.presentation = pending.presentation;
        let lease = panel.lease.clone();
        self.promote_native_views(&pending.id, &lease, &pending.target_document);
        self.finish_move(&pending.id, &lease);
        Ok(lease)
    }
    pub fn cancel(&mut self, window: &str, document: &str, id: &str) -> Result<()> {
        self.authorize(window, document)?;
        let pending = self.transfers.get(id).ok_or("transfer not found")?;
        if window != MAIN && window != pending.lease.window_id && window != pending.target_window {
            return Err("not transfer participant");
        }
        self.transfers.remove(id);
        self.cancel_move_offer(id);
        Ok(())
    }
    pub fn expire(&mut self, now: Instant) -> Vec<String> {
        self.expire_actions(now);
        let presentation_ids: Vec<_> = self.presentation_jobs.keys().cloned().collect();
        self.expire_presentation_jobs(now);
        let move_ids: Vec<_> = self.moves.keys().cloned().collect();
        self.expire_moves(now);
        let mut expired: Vec<_> = self
            .transfers
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.transfers.remove(id);
        }
        self.drags.retain(|_, grant| grant.deadline > now);
        expired.extend(
            presentation_ids
                .into_iter()
                .filter(|id| !self.presentation_jobs.contains_key(id)),
        );
        expired.extend(
            move_ids
                .into_iter()
                .filter(|id| !self.moves.contains_key(id)),
        );
        expired
    }
    pub fn issue_drag(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        now: Instant,
    ) -> Result<String> {
        self.expire(now);
        self.action(window, document, lease)?;
        let panel = self.owned(window, document, lease)?;
        if self.windows[window].closing
            || panel.blocked
            || !panel.interactions.is_empty()
            || !panel.native_actions.is_empty()
            || self
                .transfers
                .values()
                .any(|pending| pending.lease.panel_id == lease.panel_id)
        {
            return Err("panel unavailable");
        }
        // At most one outstanding grant per panel; repeated drags are bounded.
        self.drags
            .retain(|_, grant| grant.lease.panel_id != lease.panel_id);
        let id = token();
        self.drags.insert(
            id.clone(),
            DragGrant {
                lease: lease.clone(),
                document: document.into(),
                deadline: now + DRAG_TTL,
            },
        );
        Ok(id)
    }
    pub fn accept_drag(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<Lease> {
        self.authorize(window, document)?;
        if !self
            .windows
            .get(window)
            .is_some_and(|doc| doc.ready && !doc.closing)
        {
            return Err("destination unavailable");
        }
        let grant = self
            .drags
            .get(id)
            .filter(|grant| grant.deadline > now)
            .ok_or("drag expired")?;
        self.authorize_creation(&grant.lease.window_id, &grant.document, Some(&grant.lease))?;
        let lease = grant.lease.clone();
        self.drags.remove(id);
        Ok(lease)
    }
    /// Only the exact originating document can resolve/cancel a pointer drag.
    /// Tokens are single-use and cannot authorize a different lease incarnation.
    pub fn release_drag(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<Lease> {
        self.authorize(window, document)?;
        let grant = self
            .drags
            .get(id)
            .filter(|grant| grant.deadline > now)
            .ok_or("drag expired")?;
        if grant.lease.window_id != window || grant.document != document {
            return Err("invalid drag source");
        }
        self.authorize_creation(window, document, Some(&grant.lease))?;
        let lease = grant.lease.clone();
        self.drags.remove(id);
        Ok(lease)
    }
    pub fn cancel_drag(&mut self, window: &str, document: &str, id: &str) -> Result<()> {
        self.authorize(window, document)?;
        if let Some(grant) = self.drags.get(id) {
            if grant.lease.window_id != window || grant.document != document {
                return Err("invalid drag source");
            }
            self.drags.remove(id);
        }
        Ok(())
    }
    pub fn begin_close(&mut self, window: &str, document: &str) -> Result<Vec<Lease>> {
        self.authorize(window, document)?;
        if window == MAIN {
            return Err("coordinator cannot close");
        }
        let owned: Vec<_> = self
            .panels
            .values()
            .filter(|panel| panel.lease.window_id == window)
            .collect();
        if owned.iter().any(|panel| {
            panel.blocked
                || !panel.interactions.is_empty()
                || !panel.native_actions.is_empty()
                || self.panel_interrupted(&panel.lease.panel_id)
        }) {
            return Err("panel interaction in progress");
        }
        let leases = owned.into_iter().map(|panel| panel.lease.clone()).collect();
        self.windows.get_mut(window).unwrap().closing = true;
        self.save_pending_source(window);
        self.cancel_window_transfers(window);
        self.drags
            .retain(|_, grant| grant.lease.window_id != window);
        Ok(leases)
    }
    pub fn cancel_close(&mut self, window: &str, document: &str) -> Result<()> {
        self.authorize(window, document)?;
        self.windows.get_mut(window).unwrap().closing = false;
        self.cancel_window_transfers(window);
        Ok(())
    }
    pub fn can_destroy(&self, window: &str) -> bool {
        window != MAIN
            && !self
                .panels
                .values()
                .any(|panel| panel.lease.window_id == window)
            && !self
                .transfers
                .values()
                .any(|pending| pending.target_window == window || pending.lease.window_id == window)
    }
    /// Reserve empty-window destruction while holding the ownership mutex. A
    /// destination cannot acquire an incoming handoff between the emptiness
    /// check and the platform's asynchronous destroy notification.
    pub fn reserve_empty_close(&mut self, window: &str) -> Result<String> {
        if !self.can_destroy(window) {
            return Err("window still owns panels");
        }
        let target = self.windows.get_mut(window).ok_or("invalid window")?;
        target.closing = true;
        self.destroying.insert(window.into());
        Ok(target.id.clone())
    }
    pub fn release_empty_close(&mut self, window: &str) {
        self.destroying.remove(window);
        if let Some(target) = self.windows.get_mut(window) {
            target.closing = false;
        }
    }
    fn save_pending_source(&mut self, window: &str) {
        for pending in self
            .transfers
            .values()
            .filter(|pending| pending.lease.window_id == window)
        {
            if let Some(panel) = self.panels.get_mut(&pending.lease.panel_id) {
                panel.checkpoint = pending.state.clone();
            }
        }
    }
    fn cancel_window_transfers(&mut self, window: &str) {
        self.retire_window_moves(window);
        self.transfers.retain(|_, pending| {
            pending.target_window != window && pending.lease.window_id != window
        });
    }
    /// Crash recovery uses the last in-memory checkpoint (or newer prepared
    /// snapshot), not a persisted layout. Native sessions are never disconnected.
    pub fn destroyed(&mut self, window: &str) -> Result<Vec<Lease>> {
        if window == MAIN {
            return Err("coordinator must stay alive");
        }
        self.retire_document_actions(window);
        if !self.windows.contains_key(MAIN) {
            return Err("coordinator unavailable");
        }
        self.retire_presentation_document(window);
        self.save_pending_source(window);
        self.cancel_window_transfers(window);
        self.windows.remove(window);
        self.destroying.remove(window);
        self.drags
            .retain(|_, grant| grant.lease.window_id != window);
        let mut recovered = Vec::new();
        for panel in self
            .panels
            .values_mut()
            .filter(|panel| panel.lease.window_id == window)
        {
            panel.lease.window_id = MAIN.into();
            self.generation += 1;
            panel.lease.generation = self.generation;
            panel.checkpoint_revision = 0;
            panel.presentation = None;
            panel.interactions.clear();
            recovered.push(panel.lease.clone());
        }
        Ok(recovered)
    }
}
