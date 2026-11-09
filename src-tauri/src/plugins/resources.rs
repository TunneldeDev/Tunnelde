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
    accepted: bool,
}

/// Server-assigned request identity prevents reused public IDs from sharing ownership.
#[derive(Clone)]
pub(super) struct Scope {
    pub client: String,
    pub request: uuid::Uuid,
}

/// Private snapshot, never a caller-supplied resource token.
pub(super) struct Ownership {
    token: String,
    pub scope: Option<Scope>,
    pub accepted: bool,
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
                accepted: scope.is_none(),
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

    pub fn ownership(
        &self,
        owner: &str,
        generation: u64,
        matches: impl Fn(&T) -> bool,
    ) -> Option<Ownership> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.iter().find_map(|(token, entry)| {
            (entry.lease.id == owner
                && entry.lease.generation == generation
                && entry.value.as_ref().is_some_and(&matches))
            .then(|| Ownership {
                token: token.clone(),
                scope: entry.scope.clone(),
                accepted: entry.accepted,
            })
        })
    }

    pub fn accept_request(&self, owner: &str, generation: u64, request: uuid::Uuid) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        for entry in entries.values_mut() {
            if entry.lease.id == owner
                && entry.lease.generation == generation
                && entry
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope.request == request)
            {
                entry.accepted = true;
            }
        }
    }

    /// Transfer a confirmed live resource out of plugin ownership. The exact
    /// reservation token prevents stale consent from touching a replacement.
    pub fn handoff(&self, owner: &str, generation: u64, ownership: &Ownership) -> Option<T> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let entry = entries.get(&ownership.token)?;
        if entry.lease.id != owner
            || entry.lease.generation != generation
            || entry.value.is_none()
            || !entry.accepted
        {
            return None;
        }
        entries.remove(&ownership.token)?.value
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

    #[test]
    fn handoff_requires_exact_live_owner_and_accepted_result_and_releases_quota() {
        let registry = Registry::new(1, 1);
        let request = uuid::Uuid::new_v4();
        let pending = registry
            .reserve(lease("one", 1), scope("agent", request))
            .unwrap();
        assert!(registry.ownership("one", 1, |_| true).is_none());
        pending.commit("session").unwrap();
        let receipt = registry.ownership("one", 1, |_| true).unwrap();
        assert!(!receipt.accepted);
        assert!(registry.handoff("one", 1, &receipt).is_none());
        registry.accept_request("other", 1, request);
        registry.accept_request("one", 2, request);
        assert!(!registry.ownership("one", 1, |_| true).unwrap().accepted);
        registry.accept_request("one", 1, request);
        let receipt = registry.ownership("one", 1, |_| true).unwrap();
        assert!(receipt.accepted);
        assert!(registry.handoff("other", 1, &receipt).is_none());
        assert!(registry.handoff("one", 2, &receipt).is_none());
        assert_eq!(registry.handoff("one", 1, &receipt), Some("session"));
        assert!(registry.remove_client("one", 1, "agent").is_empty());
        assert!(registry.remove_request("one", 1, request).is_empty());
        assert!(registry.remove_runtime("one", |_| true).is_empty());
        let replacement = registry.reserve(lease("one", 1), None).unwrap();
        replacement.commit("session").unwrap();
        assert!(registry.handoff("one", 1, &receipt).is_none());
        assert_eq!(registry.remove_runtime("one", |_| true), ["session"]);
    }

    #[test]
    fn stale_consent_cannot_adopt_a_revoked_or_replaced_resource() {
        let registry = Registry::new(8, 64);
        registry
            .reserve(lease("one", 1), None)
            .unwrap()
            .commit("old")
            .unwrap();
        let receipt = registry
            .ownership("one", 1, |value| value == &"old")
            .unwrap();
        assert!(receipt.accepted);
        assert_eq!(registry.remove_runtime("one", |_| true), ["old"]);
        registry
            .reserve(lease("one", 2), None)
            .unwrap()
            .commit("old")
            .unwrap();
        assert!(registry.handoff("one", 2, &receipt).is_none());
        assert_eq!(registry.remove_runtime("one", |_| true), ["old"]);
    }

    #[test]
    fn handoff_and_runtime_cleanup_have_only_one_winner() {
        for _ in 0..64 {
            let registry = Registry::new(8, 64);
            registry
                .reserve(lease("one", 1), None)
                .unwrap()
                .commit("session")
                .unwrap();
            let receipt = registry.ownership("one", 1, |_| true).unwrap();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|threads| {
                let worker = threads.spawn(|| {
                    barrier.wait();
                    registry.handoff("one", 1, &receipt)
                });
                barrier.wait();
                let closed = registry.remove_runtime("one", |_| true);
                let adopted = worker.join().unwrap();
                assert_eq!(closed.len() + usize::from(adopted.is_some()), 1);
            });
        }
    }
}
