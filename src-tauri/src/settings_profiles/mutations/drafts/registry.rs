use super::*;
use crate::{
    error::{AppError, AppResult},
    settings_profiles::{
        content::MAX_CONTENT_BYTES,
        mutations::contracts::{self, Draft},
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(crate) struct Registry(Mutex<HashMap<String, Entry>>);
pub(crate) struct Claim {
    registry: Arc<Registry>,
    id: String,
    pub text: String,
    pub revision: String,
}
impl Drop for Claim {
    fn drop(&mut self) {
        self.registry
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}
impl Registry {
    pub(crate) fn prepare(&self, owner: Owner, revision: String, total: usize) -> AppResult<Draft> {
        self.prepare_at(owner, revision, total, Instant::now())
    }
    fn prepare_at(
        &self,
        owner: Owner,
        revision: String,
        total: usize,
        now: Instant,
    ) -> AppResult<Draft> {
        contracts::revision(&revision)?;
        if total == 0 || total > MAX_CONTENT_BYTES {
            return Err(contracts::invalid());
        }
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, value| !value.expired(now));
        if entries.len() >= MAX_DRAFTS
            || entries.values().filter(|v| v.owner == owner).count() >= MAX_OWNER_DRAFTS
            || entries.values().map(|v| v.total).sum::<usize>() + total > MAX_RESERVED
        {
            return Err(AppError::validation("profiles.draft.limit"));
        }
        // Reserve the declared budget once. Geometric growth per append could
        // otherwise exceed charged bytes or repeatedly copy a large upload.
        let mut text = String::new();
        text.try_reserve_exact(total)
            .map_err(|_| AppError::validation("profiles.draft.limit"))?;
        let id = uuid::Uuid::new_v4().to_string();
        entries.insert(
            id.clone(),
            Entry {
                owner,
                revision,
                total,
                created: now,
                touched: now,
                text: Some(text),
            },
        );
        Ok(Draft {
            version: 1,
            draft_id: id,
            total_bytes: total,
            offset: 0,
        })
    }
    pub(crate) fn append(&self, owner: &Owner, request: contracts::Append) -> AppResult<Draft> {
        contracts::id(&request.draft_id)?;
        if request.text.is_empty() || request.text.len() > MAX_APPEND_BYTES {
            return Err(contracts::invalid());
        }
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        entries.retain(|_, value| !value.expired(now));
        let entry = entries
            .get_mut(&request.draft_id)
            .filter(|v| &v.owner == owner)
            .ok_or_else(missing)?;
        let text = entry
            .text
            .as_mut()
            .ok_or_else(|| AppError::validation("profiles.draft.busy"))?;
        if text.len() != request.offset
            || request.text.len() > entry.total.saturating_sub(text.len())
        {
            return Err(AppError::validation("profiles.draft.invalidOffset"));
        }
        text.push_str(&request.text);
        entry.touched = now;
        Ok(Draft {
            version: 1,
            draft_id: request.draft_id,
            total_bytes: entry.total,
            offset: text.len(),
        })
    }
    /// Idempotent for absent/expired/foreign IDs; never discloses another owner.
    pub(crate) fn discard(&self, owner: &Owner, id: &str) -> AppResult<()> {
        contracts::id(id)?;
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(id).filter(|v| &v.owner == owner) {
            if entry.text.is_none() {
                return Err(AppError::validation("profiles.draft.busy"));
            }
            entries.remove(id);
        }
        Ok(())
    }
    pub(crate) fn claim(self: &Arc<Self>, owner: &Owner, id: &str) -> AppResult<Claim> {
        contracts::id(id)?;
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, value| !value.expired(Instant::now()));
        let entry = entries
            .get_mut(id)
            .filter(|v| &v.owner == owner)
            .ok_or_else(missing)?;
        let text = entry
            .text
            .as_ref()
            .ok_or_else(|| AppError::validation("profiles.draft.busy"))?;
        if text.len() != entry.total {
            return Err(AppError::validation("profiles.draft.incomplete"));
        }
        Ok(Claim {
            registry: self.clone(),
            id: id.into(),
            text: entry.text.take().expect("checked body"),
            revision: entry.revision.clone(),
        })
    }
    pub(crate) fn retire_before(&self, id: &str, generation: u64) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, entry| {
                entry.owner.id != id || entry.owner.generation >= generation || entry.text.is_none()
            });
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
