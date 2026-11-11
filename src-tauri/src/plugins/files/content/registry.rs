use super::{contracts::*, Entry};
use crate::{
    error::AppResult,
    plugins::{
        runtime::ownership::{Ownership, Registry},
        security::Lease,
    },
};
use std::sync::{Arc, OnceLock};

pub(in crate::plugins) struct Content {
    registry: Arc<Registry<Arc<Entry>>>,
    reaper: OnceLock<()>,
}
impl Default for Content {
    fn default() -> Self {
        Self {
            registry: Registry::new(8, 64),
            reaper: OnceLock::new(),
        }
    }
}
impl Content {
    fn prune(&self) {
        for entry in self.registry.forget(|e| e.expired()) {
            entry.close();
        }
    }
    pub fn prepare(&self, lease: Lease, request: Prepare) -> AppResult<Prepared> {
        request.validate()?;
        self.prune();
        let reservation = self.registry.reserve(lease, None)?;
        let entry = Arc::new(Entry::new(request));
        let result = Prepared {
            version: 1,
            content_id: entry.id.clone(),
            lease_ms: PREPARED_MS,
        };
        reservation
            .commit(entry.clone())
            .map_err(|_| unavailable())?;
        // One sweeper per manager, not one sleeping task per open/close cycle.
        // Requests enforce the exact deadline; idle native handles are reclaimed
        // within the following second even when no caller returns to the API.
        self.reaper.get_or_init(|| {
            let registry = Arc::downgrade(&self.registry);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let Some(registry) = registry.upgrade() else {
                        return;
                    };
                    for entry in registry.forget(|e| e.expired()) {
                        entry.close();
                    }
                }
            });
        });
        Ok(result)
    }
    pub fn owned(&self, owner: &str, generation: u64) -> Vec<(Ownership, Arc<Entry>)> {
        self.prune();
        self.registry.owned(owner, generation)
    }
    pub fn get(&self, owner: &str, generation: u64, id: &str) -> AppResult<Arc<Entry>> {
        super::contracts::id(id)?;
        self.owned(owner, generation)
            .into_iter()
            .find(|(_, e)| e.id == id)
            .map(|(_, e)| e)
            .ok_or_else(unavailable)
    }
    pub fn close(&self, owner: &str, generation: u64, id: &str) -> AppResult<Option<bool>> {
        super::contracts::id(id)?;
        let Some((receipt, _)) = self
            .owned(owner, generation)
            .into_iter()
            .find(|(_, e)| e.id == id)
        else {
            return Ok(None);
        };
        Ok(self.release(owner, generation, &receipt))
    }
    pub fn release(&self, owner: &str, generation: u64, receipt: &Ownership) -> Option<bool> {
        self.registry
            .handoff(owner, generation, receipt)
            .map(|entry| entry.close())
    }
    pub fn retire_before(&self, owner: &str, boundary: u64) {
        for entry in self.registry.remove_runtime(owner, |g| g < boundary) {
            entry.close();
        }
    }
}
