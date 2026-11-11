use super::{
    identity::{Entry, Ownership, Scope},
    reservation::Reservation,
};
use crate::{
    error::{AppError, AppResult},
    plugins::security::Lease,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub(in crate::plugins) struct Registry<T> {
    pub(super) entries: Mutex<BTreeMap<String, Entry<T>>>,
    per_plugin: usize,
    total: usize,
}

impl<T> Registry<T> {
    /// Includes unaccepted values: native consumers must never silently borrow
    /// a transport still governed by any plugin runtime or pending request.
    pub fn contains(&self, matches: impl Fn(&T) -> bool) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|entry| entry.value.as_ref().is_some_and(&matches))
    }
    /// Accepted live values only. Pending results remain owned but cannot be
    /// controlled through a different public call before result acceptance.
    pub fn owned(&self, owner: &str, generation: u64) -> Vec<(Ownership, T)>
    where
        T: Clone,
    {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, entry)| {
                entry.lease.id == owner && entry.lease.generation == generation && entry.accepted
            })
            .filter_map(|(token, entry)| {
                entry.value.clone().map(|value| {
                    (
                        Ownership {
                            token: token.clone(),
                            scope: entry.scope.clone(),
                            accepted: entry.accepted,
                        },
                        value,
                    )
                })
            })
            .collect()
    }
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
