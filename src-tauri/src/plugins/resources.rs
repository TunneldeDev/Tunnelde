//! Runtime-owned resources, including reservations for operations still in flight.
//! Removal returns live resources to the domain adapter; never do I/O under this lock.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use super::security::Lease;
use crate::error::{AppError, AppResult};

struct Entry<T> {
    lease: Lease,
    value: Option<T>,
}

pub(super) struct Registry<T> {
    entries: Mutex<BTreeMap<String, Entry<T>>>,
    per_plugin: usize,
    total: usize,
}

impl<T> Registry<T> {
    pub fn new(per_plugin: usize, total: usize) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(BTreeMap::new()),
            per_plugin,
            total,
        })
    }

    /// Caller serializes admission and completion with permission revocation.
    pub fn reserve(self: &Arc<Self>, lease: Lease) -> AppResult<Reservation<T>> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= self.total
            || entries
                .values()
                .filter(|entry| entry.lease.id == lease.id)
                .count()
                >= self.per_plugin
        {
            return Err(AppError::validation("plugin.resources.limit"));
        }
        let token = uuid::Uuid::new_v4().to_string();
        entries.insert(token.clone(), Entry { lease, value: None });
        Ok(Reservation {
            registry: self.clone(),
            token,
            committed: false,
        })
    }

    pub fn remove_runtime(&self, owner: &str, generation: impl Fn(u64) -> bool) -> Vec<T> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<_> = entries
            .iter()
            .filter(|(_, entry)| entry.lease.id == owner && generation(entry.lease.generation))
            .map(|(key, _)| key.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| entries.remove(&key)?.value)
            .collect()
    }

    pub fn forget(&self, matches: impl Fn(&T) -> bool) -> Vec<T> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<_> = entries
            .iter()
            .filter(|(_, entry)| entry.value.as_ref().is_some_and(&matches))
            .map(|(key, _)| key.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| entries.remove(&key)?.value)
            .collect()
    }
}

pub(super) struct Reservation<T> {
    registry: Arc<Registry<T>>,
    token: String,
    committed: bool,
}

impl<T> Reservation<T> {
    /// Keep the value on failure so the adapter can dispose it outside the lock.
    pub fn commit(mut self, value: T) -> Result<(), T> {
        let mut entries = self
            .registry
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(entry) = entries.get_mut(&self.token) else {
            return Err(value);
        };
        entry.value = Some(value);
        self.committed = true;
        Ok(())
    }
}

impl<T> Drop for Reservation<T> {
    fn drop(&mut self) {
        if !self.committed {
            self.registry
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(owner: &str, generation: u64) -> Lease {
        Lease {
            id: owner.into(),
            generation,
            fingerprint: "a".repeat(64),
            permissions: vec![],
        }
    }

    #[test]
    fn pending_and_live_resources_share_bounded_budgets() {
        let registry = Registry::new(2, 3);
        let pending = registry.reserve(lease("one", 1)).unwrap();
        registry
            .reserve(lease("one", 1))
            .unwrap()
            .commit("live")
            .unwrap();
        assert!(registry.reserve(lease("one", 2)).is_err());
        let other = registry.reserve(lease("two", 1)).unwrap();
        assert!(registry.reserve(lease("three", 1)).is_err());
        drop(pending);
        let replacement = registry.reserve(lease("one", 2)).unwrap();
        drop(other);
        drop(replacement);
        registry.forget(|value| value == &"live");
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn cleanup_rejects_late_completion_without_touching_new_generation_or_other_owner() {
        let registry = Registry::new(8, 64);
        let pending = registry.reserve(lease("one", 1)).unwrap();
        registry
            .reserve(lease("one", 1))
            .unwrap()
            .commit("old")
            .unwrap();
        registry
            .reserve(lease("one", 2))
            .unwrap()
            .commit("new")
            .unwrap();
        registry
            .reserve(lease("two", 1))
            .unwrap()
            .commit("other")
            .unwrap();
        assert_eq!(registry.remove_runtime("one", |g| g < 2), ["old"]);
        assert_eq!(pending.commit("late"), Err("late"));
        assert!(registry.remove_runtime("one", |g| g == 1).is_empty());
        assert_eq!(registry.remove_runtime("one", |g| g == 2), ["new"]);
        assert_eq!(registry.remove_runtime("two", |_| true), ["other"]);
    }

    #[test]
    fn cancelled_reservation_cannot_remove_a_later_reservation() {
        let registry = Registry::<String>::new(1, 1);
        let old = registry.reserve(lease("one", 1)).unwrap();
        registry.remove_runtime("one", |_| true);
        let new = registry.reserve(lease("one", 2)).unwrap();
        drop(old);
        new.commit("new".into()).unwrap();
        assert_eq!(registry.remove_runtime("one", |_| true), ["new"]);
    }
}
