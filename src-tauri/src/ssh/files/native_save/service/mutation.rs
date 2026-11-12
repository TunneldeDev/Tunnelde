//! Durable legacy ownership uses the same bounded workers as native recovery.
use super::*;
use journal::admission::{Claim, Dispatched, Kind, Scope};

pub(in super::super) struct Worker {
    id: String,
    registry: Arc<Mutex<std::collections::HashSet<String>>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

impl<S: Secrets + 'static> Service<S> {
    pub fn observe_legacy_worker(&self, id: &str) -> Worker {
        self.legacy_workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.into());
        Worker {
            id: id.into(),
            registry: self.legacy_workers.clone(),
        }
    }
    pub fn legacy_worker_running(&self, id: &str) -> bool {
        self.legacy_workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id)
    }
    pub async fn legacy_claims(&self) -> journal::Result<Vec<Claim>> {
        self.blocking(|storage| storage.journal()?.legacy_claims())
            .await
    }
    pub async fn admission_enabled(&self) -> journal::Result<bool> {
        self.blocking(|storage| storage.journal()?.admission_enabled())
            .await
    }
    pub async fn reserve_legacy(
        &self,
        kind: Kind,
        owner: journal::Owner,
        scopes: Vec<Scope>,
    ) -> journal::Result<Claim> {
        self.blocking(move |storage| storage.journal()?.reserve_legacy(kind, owner, scopes))
            .await
    }
    pub async fn dispatch_legacy(&self, claim: &Claim) -> journal::Result<Dispatched> {
        let claim = claim.clone();
        self.blocking(move |storage| storage.journal()?.dispatch_legacy(&claim))
            .await
    }
    pub async fn retire_unsent_legacy(&self, claim: &Claim) -> journal::Result<()> {
        let claim = claim.clone();
        self.blocking(move |storage| storage.journal()?.retire_unsent_legacy(&claim))
            .await
    }
    pub async fn settle_legacy(&self, permit: Dispatched) -> journal::Result<()> {
        self.blocking(move |storage| storage.journal()?.settle_legacy(permit))
            .await
    }
}
