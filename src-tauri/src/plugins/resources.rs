//! Runtime-owned resources, including reservations for operations still in flight.
//! Removal returns live resources to the domain adapter; never do I/O under this lock.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use super::security::Lease;
use crate::error::{AppError, AppResult};

struct Entry<T> {
    lease: Lease,
    scope: Option<Scope>,
    value: Option<T>,
}

/// Server-assigned request identity prevents reused public IDs from sharing ownership.
#[derive(Clone)]
pub(super) struct Scope {
    pub client: String,
    pub request: uuid::Uuid,
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
    pub fn reserve(
        self: &Arc<Self>,
        lease: Lease,
        scope: Option<Scope>,
    ) -> AppResult<Reservation<T>> {
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
        entries.insert(
            token.clone(),
            Entry {
                lease,
                scope,
                value: None,
            },
        );
        Ok(Reservation {
            registry: self.clone(),
            token,
            committed: false,
        })
    }

    pub fn remove_runtime(&self, owner: &str, generation: impl Fn(u64) -> bool) -> Vec<T> {
        self.remove_scoped(owner, generation, |_| true)
    }

    pub fn remove_client(&self, owner: &str, generation: u64, client: &str) -> Vec<T> {
        self.remove_scoped(
            owner,
            |value| value == generation,
            |scope| scope.is_some_and(|scope| scope.client == client),
        )
    }

    pub fn remove_request(&self, owner: &str, generation: u64, request: uuid::Uuid) -> Vec<T> {
        self.remove_scoped(
            owner,
            |value| value == generation,
            |scope| scope.is_some_and(|scope| scope.request == request),
        )
    }

    fn remove_scoped(
        &self,
        owner: &str,
        generation: impl Fn(u64) -> bool,
        scope: impl Fn(Option<&Scope>) -> bool,
    ) -> Vec<T> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<_> = entries
            .iter()
            .filter(|(_, entry)| {
                entry.lease.id == owner
                    && generation(entry.lease.generation)
                    && scope(entry.scope.as_ref())
            })
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
        let pending = registry.reserve(lease("one", 1), None).unwrap();
        registry
            .reserve(lease("one", 1), None)
            .unwrap()
            .commit("live")
            .unwrap();
        assert!(registry.reserve(lease("one", 2), None).is_err());
        let other = registry.reserve(lease("two", 1), None).unwrap();
        assert!(registry.reserve(lease("three", 1), None).is_err());
        drop(pending);
        let replacement = registry.reserve(lease("one", 2), None).unwrap();
        drop(other);
        drop(replacement);
        registry.forget(|value| value == &"live");
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn cleanup_rejects_late_completion_without_touching_new_generation_or_other_owner() {
        let registry = Registry::new(8, 64);
        let pending = registry.reserve(lease("one", 1), None).unwrap();
        registry
            .reserve(lease("one", 1), None)
            .unwrap()
            .commit("old")
            .unwrap();
        registry
            .reserve(lease("one", 2), None)
            .unwrap()
            .commit("new")
            .unwrap();
        registry
            .reserve(lease("two", 1), None)
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
        let old = registry.reserve(lease("one", 1), None).unwrap();
        registry.remove_runtime("one", |_| true);
        let new = registry.reserve(lease("one", 2), None).unwrap();
        drop(old);
        new.commit("new".into()).unwrap();
        assert_eq!(registry.remove_runtime("one", |_| true), ["new"]);
    }

    fn scope(client: &str, request: uuid::Uuid) -> Option<Scope> {
        Some(Scope {
            client: client.into(),
            request,
        })
    }

    #[test]
    fn client_cleanup_releases_pending_and_live_without_crossing_ownership_boundaries() {
        let registry = Registry::new(8, 16);
        let request = uuid::Uuid::new_v4();
        let pending = registry
            .reserve(lease("one", 1), scope("a", request))
            .unwrap();
        for (owner, generation, client, value) in [
            ("one", 1, Some("a"), "revoked"),
            ("one", 1, Some("b"), "other-client"),
            ("one", 1, None, "direct-plugin"),
            ("one", 2, Some("a"), "replacement"),
            ("two", 1, Some("a"), "other-plugin"),
        ] {
            registry
                .reserve(
                    lease(owner, generation),
                    client.and_then(|c| scope(c, request)),
                )
                .unwrap()
                .commit(value)
                .unwrap();
        }
        assert_eq!(registry.remove_client("one", 1, "a"), ["revoked"]);
        assert_eq!(pending.commit("late"), Err("late"));
        assert!(registry.remove_client("one", 1, "a").is_empty());
        assert_eq!(registry.remove_client("one", 1, "b"), ["other-client"]);
        assert_eq!(registry.remove_client("one", 2, "a"), ["replacement"]);
        assert_eq!(registry.remove_client("two", 1, "a"), ["other-plugin"]);
        assert_eq!(registry.remove_runtime("one", |_| true), ["direct-plugin"]);
    }

    #[test]
    fn abandoned_request_cleanup_cannot_remove_a_reused_public_request_id() {
        let registry = Registry::new(8, 16);
        let old = uuid::Uuid::new_v4();
        let replacement = uuid::Uuid::new_v4();
        let pending = registry.reserve(lease("one", 1), scope("a", old)).unwrap();
        registry
            .reserve(lease("one", 1), scope("a", old))
            .unwrap()
            .commit("old-live")
            .unwrap();
        registry
            .reserve(lease("one", 1), scope("a", replacement))
            .unwrap()
            .commit("new-live")
            .unwrap();
        registry
            .reserve(lease("one", 2), scope("a", old))
            .unwrap()
            .commit("new-runtime")
            .unwrap();
        registry
            .reserve(lease("two", 1), scope("a", old))
            .unwrap()
            .commit("other-plugin")
            .unwrap();
        assert_eq!(registry.remove_request("one", 1, old), ["old-live"]);
        assert_eq!(pending.commit("late"), Err("late"));
        assert!(registry.remove_request("one", 1, old).is_empty());
        assert_eq!(registry.remove_request("one", 1, replacement), ["new-live"]);
        assert_eq!(registry.remove_request("one", 2, old), ["new-runtime"]);
        assert_eq!(registry.remove_request("two", 1, old), ["other-plugin"]);
    }

    #[test]
    fn revoked_pending_reservations_release_capacity_before_their_futures_finish() {
        let registry = Registry::<&str>::new(1, 1);
        let request = uuid::Uuid::new_v4();
        let old = registry
            .reserve(lease("one", 1), scope("a", request))
            .unwrap();
        assert!(registry
            .reserve(lease("one", 1), scope("b", request))
            .is_err());
        registry.remove_client("one", 1, "a");
        let new = registry
            .reserve(lease("one", 1), scope("b", request))
            .unwrap();
        drop(old);
        new.commit("new").unwrap();
        assert_eq!(registry.remove_client("one", 1, "b"), ["new"]);
    }
}
