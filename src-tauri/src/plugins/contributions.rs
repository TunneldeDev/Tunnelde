//! Ephemeral, runtime-owned UI contributions. Nothing here is persisted or tied
//! to frontend layout state. Revocation and late runtime exits cannot remove a
//! replacement runtime's contributions.
use std::collections::BTreeMap;
use std::sync::Mutex;

use super::security::Lease;
use crate::error::{AppError, AppResult};

#[derive(Clone)]
pub(super) struct Owned<T> {
    pub lease: Lease,
    pub token: String,
    pub value: T,
}

struct State<T> {
    revision: u64,
    items: BTreeMap<(String, String), Owned<T>>,
}

pub(super) struct Registry<T>(Mutex<State<T>>);

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self(Mutex::new(State {
            revision: 0,
            items: BTreeMap::new(),
        }))
    }
}

impl<T: Clone> Registry<T> {
    pub fn upsert(
        &self,
        lease: Lease,
        id: String,
        value: T,
        valid: impl Fn(&Lease) -> AppResult<()>,
    ) -> AppResult<()> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        // Validate under the registry lock. Invalidation releases its policy
        // lock before cleanup takes this lock, so a late registration is either
        // rejected here or removed by that cleanup.
        valid(&lease)?;
        state.items.retain(|_, item| valid(&item.lease).is_ok());
        let key = (lease.id.clone(), id);
        if !state.items.contains_key(&key)
            && (state.items.len() >= 128
                || state
                    .items
                    .keys()
                    .filter(|(owner, _)| owner == &lease.id)
                    .count()
                    >= 8)
        {
            return Err(AppError::validation("plugin.statusBar.limit"));
        }
        state.items.insert(
            key,
            Owned {
                lease,
                token: uuid::Uuid::new_v4().to_string(),
                value,
            },
        );
        state.revision += 1;
        Ok(())
    }

    pub fn remove(
        &self,
        lease: &Lease,
        id: &str,
        valid: impl Fn(&Lease) -> AppResult<()>,
    ) -> AppResult<bool> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        valid(lease)?;
        let key = (lease.id.clone(), id.to_owned());
        let matches = state
            .items
            .get(&key)
            .is_some_and(|item| item.lease.generation == lease.generation);
        if matches {
            state.items.remove(&key);
            state.revision += 1;
        }
        Ok(matches)
    }

    pub fn snapshot(&self, valid: impl Fn(&Lease) -> bool) -> (u64, Vec<Owned<T>>) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let previous = state.items.len();
        state.items.retain(|_, item| valid(&item.lease));
        if state.items.len() != previous {
            state.revision += 1;
        }
        (state.revision, state.items.values().cloned().collect())
    }

    pub fn remove_runtime(&self, owner: &str, generation: impl Fn(u64) -> bool) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let previous = state.items.len();
        state
            .items
            .retain(|(id, _), item| id != owner || !generation(item.lease.generation));
        if state.items.len() != previous {
            state.revision += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lease(id: &str, generation: u64) -> Lease {
        Lease {
            id: id.into(),
            generation,
            fingerprint: "digest".into(),
            permissions: vec![],
        }
    }

    #[test]
    fn runtime_ownership_replacement_and_quota() {
        let registry = Registry::default();
        registry
            .upsert(lease("a", 1), "item".into(), 1, |_| Ok(()))
            .unwrap();
        registry
            .upsert(lease("b", 1), "item".into(), 2, |_| Ok(()))
            .unwrap();
        registry
            .upsert(lease("a", 2), "item".into(), 3, |_| Ok(()))
            .unwrap();
        registry.remove_runtime("a", |generation| generation < 2);
        assert!(!registry.remove(&lease("a", 1), "item", |_| Ok(())).unwrap());
        let (revision, items) = registry.snapshot(|_| true);
        assert_eq!(revision, 3);
        assert_eq!(
            items.iter().map(|item| item.value).collect::<Vec<_>>(),
            [3, 2]
        );
        for index in 0..7 {
            registry
                .upsert(lease("a", 2), index.to_string(), 0, |_| Ok(()))
                .unwrap();
        }
        assert!(registry
            .upsert(lease("a", 2), "overflow".into(), 0, |_| Ok(()))
            .is_err());
        registry.remove_runtime("a", |_| true);
        assert_eq!(registry.snapshot(|_| true).1.len(), 1);
        assert!(registry.snapshot(|_| false).1.is_empty());
    }

    #[test]
    fn rejected_registration_cannot_mutate_state() {
        let registry = Registry::default();
        registry
            .upsert(lease("a", 1), "item".into(), 1, |_| Ok(()))
            .unwrap();
        let original = registry.snapshot(|_| true).1[0].token.clone();
        assert!(registry
            .upsert(lease("a", 1), "item".into(), 2, |_| Err(
                AppError::validation("revoked")
            ))
            .is_err());
        assert_eq!(registry.snapshot(|_| true).1[0].token, original);
    }
}
