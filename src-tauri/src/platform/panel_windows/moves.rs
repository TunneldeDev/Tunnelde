//! Plugin-requested moves execute in the current source document, not in the
//! coordinator's stale stores. Native owns admission, cancellation and commit.
use super::ownership::{Lease, Ownership};
use crate::plugins::security::Lease as PluginLease;
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

type Result<T> = std::result::Result<T, &'static str>;
pub(super) type MoveReply = oneshot::Receiver<Result<Lease>>;
const TTL: Duration = Duration::from_secs(25);

pub(super) struct PendingMove {
    lease: Lease,
    source_document: String,
    target_window: String,
    target_document: String,
    owner: PluginLease,
    invocation: Option<crate::plugins::InvocationFence>,
    claimed: bool,
    offer: Option<String>,
    deadline: Instant,
    reply: oneshot::Sender<Result<Lease>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MoveJob {
    pub id: String,
    pub lease: Lease,
    pub target_window: String,
}
impl Ownership {
    pub(super) fn submit_move(
        &mut self,
        owner: PluginLease,
        panel_id: &str,
        target: &str,
        expected: Option<(&str, u64)>,
        now: Instant,
    ) -> Result<(String, MoveReply)> {
        self.expire(now);
        let lease = self
            .leases()
            .into_iter()
            .find(|p| p.panel_id == panel_id)
            .ok_or("panel not found")?;
        if expected.is_some_and(|(window, generation)| {
            window != lease.window_id || generation != lease.generation
        }) {
            return Err("stale panel owner");
        }
        let source = self
            .document(&lease.window_id)
            .ok_or("source unavailable")?
            .to_owned();
        self.authorize_creation(&lease.window_id, &source, Some(&lease))?;
        if target == lease.window_id {
            return Err("same window");
        }
        if !self
            .windows()
            .iter()
            .any(|w| w.id == target && w.ready && !w.closing)
        {
            return Err("destination unavailable");
        }
        let target_document = self
            .document(target)
            .ok_or("destination unavailable")?
            .to_owned();
        if self.moves.len() >= 32
            || self
                .moves
                .values()
                .filter(|m| m.owner.id == owner.id)
                .count()
                >= 8
        {
            return Err("panel move limit");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receiver) = oneshot::channel();
        self.relay_fence(panel_id, &id, true)?;
        self.moves.insert(
            id.clone(),
            PendingMove {
                lease,
                source_document: source,
                target_window: target.into(),
                target_document,
                owner,
                invocation: crate::plugins::current_invocation_fence(),
                claimed: false,
                offer: None,
                deadline: now + TTL,
                reply,
            },
        );
        Ok((id, receiver))
    }
    fn move_source(&self, window: &str, document: &str, id: &str) -> Result<&PendingMove> {
        self.authorize(window, document)?;
        let job = self.moves.get(id).ok_or("panel move expired")?;
        if job.lease.window_id != window || job.source_document != document {
            return Err("invalid move source");
        }
        self.owned(window, document, &job.lease)?;
        Ok(job)
    }
    fn move_available(&self, job: &PendingMove, id: &str) -> Result<()> {
        self.action(&job.lease.window_id, &job.source_document, &job.lease)?;
        self.authorize(&job.target_window, &job.target_document)?;
        self.authorize_move_fence(&job.lease.window_id, &job.source_document, &job.lease, id)?;
        if !self
            .windows()
            .iter()
            .any(|w| w.id == job.target_window && w.ready && !w.closing)
        {
            return Err("destination unavailable");
        }
        Ok(())
    }
    pub(super) fn claim_moves(
        &mut self,
        window: &str,
        document: &str,
        now: Instant,
        policy: impl Fn(&PluginLease) -> Result<()>,
    ) -> Result<Vec<MoveJob>> {
        self.authorize(window, document)?;
        self.expire_moves(now);
        let ids: Vec<_> = self
            .moves
            .iter()
            .filter(|(_, j)| j.lease.window_id == window && !j.claimed)
            .map(|(id, _)| id.clone())
            .collect();
        let mut jobs = Vec::new();
        for id in ids {
            let checked = self.move_source(window, document, &id).and_then(|job| {
                self.move_available(job, &id)?;
                policy(&job.owner)
            });
            if let Err(error) = checked {
                self.cancel_move(&id, error);
                continue;
            }
            let job = self.moves.get_mut(&id).unwrap();
            job.claimed = true;
            jobs.push(MoveJob {
                id,
                lease: job.lease.clone(),
                target_window: job.target_window.clone(),
            });
        }
        Ok(jobs)
    }
    pub(super) fn prepare_move(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        state: Value,
        now: Instant,
        policy: impl Fn(&PluginLease) -> Result<()>,
    ) -> Result<super::ownership::Offer> {
        self.expire_moves(now);
        let job = self.move_source(window, document, id)?;
        if !job.claimed || job.offer.is_some() {
            return Err("invalid move phase");
        }
        if let Err(error) = self
            .move_available(job, id)
            .and_then(|()| policy(&job.owner))
        {
            self.cancel_move(id, error);
            return Err(error);
        }
        let lease = job.lease.clone();
        let target = job.target_window.clone();
        // Exchange only this request's fence for the normal staged handoff in
        // ONE ownership transaction. Other actions/consent still reject it.
        self.relay_fence(&lease.panel_id, id, false)?;
        // prepare() expires other requests. Keep this one's sender out of that
        // sweep: its receiver can close independently while ownership is locked.
        let mut job = self.moves.remove(id).unwrap();
        match self.prepare(window, document, &lease, &target, state, now) {
            Ok(offer) if !job.reply.is_closed() => {
                job.offer = Some(offer.id.clone());
                self.moves.insert(id.into(), job);
                Ok(offer)
            }
            Ok(offer) => {
                self.discard_move_offer(&offer.id);
                Err("panel.window.cancelled")
            }
            Err(error) => {
                let _ = job.reply.send(Err(error));
                Err(error)
            }
        }
    }
    pub(super) fn fail_move(&mut self, window: &str, document: &str, id: &str) -> Result<()> {
        self.move_source(window, document, id)?;
        self.cancel_move(id, "panel.window.sourceUnavailable");
        Ok(())
    }
    pub(super) fn cancel_move(&mut self, id: &str, error: &'static str) -> bool {
        let Some(job) = self.moves.remove(id) else {
            return false;
        };
        let _ = self.relay_fence(&job.lease.panel_id, id, false);
        if let Some(offer) = job.offer {
            self.discard_move_offer(&offer);
        }
        let _ = job.reply.send(Err(error));
        true
    }
    pub(super) fn move_invocation_for_offer(
        &self,
        offer: &str,
    ) -> Option<crate::plugins::InvocationFence> {
        self.moves
            .values()
            .find(|job| job.offer.as_deref() == Some(offer))
            .and_then(|job| job.invocation.clone())
    }
    pub(super) fn move_owner_for_offer(&self, offer: &str) -> Option<PluginLease> {
        self.moves
            .values()
            .find(|job| job.offer.as_deref() == Some(offer))
            .map(|job| job.owner.clone())
    }
    pub(super) fn authorize_move_commit(
        &mut self,
        offer: &str,
        now: Instant,
        policy: impl Fn(&PluginLease) -> Result<()>,
    ) -> Result<()> {
        self.expire_moves(now);
        let job = self
            .moves
            .iter()
            .find(|(_, job)| job.offer.as_deref() == Some(offer));
        if let Some((id, job)) = job {
            if let Err(error) = policy(&job.owner) {
                let id = id.clone();
                self.cancel_move(&id, error);
                return Err(error);
            }
        }
        Ok(())
    }
    pub(super) fn finish_move(&mut self, offer: &str, lease: &Lease) {
        let id = self
            .moves
            .iter()
            .find(|(_, job)| job.offer.as_deref() == Some(offer))
            .map(|(id, _)| id.clone());
        if let Some(job) = id.and_then(|id| self.moves.remove(&id)) {
            let _ = job.reply.send(Ok(lease.clone()));
        }
    }
    pub(super) fn cancel_move_offer(&mut self, offer: &str) {
        let id = self
            .moves
            .iter()
            .find(|(_, job)| job.offer.as_deref() == Some(offer))
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            self.cancel_move(&id, "panel.window.cancelled");
        }
    }
    pub(super) fn retire_window_moves(&mut self, window: &str) {
        let ids: Vec<_> = self
            .moves
            .iter()
            .filter(|(_, j)| j.lease.window_id == window || j.target_window == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_move(&id, "stale window document");
        }
    }
    pub(super) fn retire_panel_moves(&mut self, panel: &str) {
        let ids: Vec<_> = self
            .moves
            .iter()
            .filter(|(_, j)| j.lease.panel_id == panel)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_move(&id, "panel not found");
        }
    }
    pub(super) fn expire_moves(&mut self, now: Instant) {
        let ids: Vec<_> = self
            .moves
            .iter()
            .filter(|(_, job)| {
                job.deadline <= now
                    || job.reply.is_closed()
                    || job
                        .offer
                        .as_ref()
                        .is_some_and(|id| !self.move_offer_exists(id, now))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_move(&id, "panel.window.cancelled");
        }
    }
}

#[cfg(test)]
mod tests;
