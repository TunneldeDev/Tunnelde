//! App-scoped short transactions and bounded remote-operation admission.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};

const GLOBAL_LIMIT: usize = 16;
const PLUGIN_LIMIT: usize = 4;

#[derive(Default)]
pub(crate) struct Coordinator {
    pub(super) browsers: super::management::browser::registry::Registry,
    pub(super) metadata: Mutex<()>,
    active: Arc<Mutex<HashMap<(String, String), bool>>>,
    pub(super) recovery: Mutex<Recovery>,
    pub(super) recovery_signal: tokio::sync::Notify,
}

#[derive(Default)]
pub(super) struct Recovery {
    pub(super) running: bool,
    pub(super) requested: bool,
}

pub(super) struct Lease {
    active: Arc<Mutex<HashMap<(String, String), bool>>>,
    key: (String, String),
}

impl Coordinator {
    pub(super) fn admit(&self, plugin: &str, key: &str) -> AppResult<Lease> {
        self.admit_kind(plugin, key, false)
    }

    pub(super) fn admit_cleanup(&self, plugin: &str, key: &str) -> AppResult<Lease> {
        self.admit_kind(plugin, key, true)
    }

    fn admit_kind(&self, plugin: &str, key: &str, cleanup: bool) -> AppResult<Lease> {
        let key = (plugin.to_owned(), key.to_owned());
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active.len() >= GLOBAL_LIMIT
            || active.keys().filter(|(id, _)| id == plugin).count() >= PLUGIN_LIMIT
            || active.contains_key(&key)
            || (cleanup
                && (active.values().filter(|value| **value).count() >= 8
                    || active
                        .iter()
                        .filter(|((id, _), value)| id == plugin && **value)
                        .count()
                        >= 2))
        {
            return Err(AppError::validation("plugin.runners.busy"));
        }
        active.insert(key.clone(), cleanup);
        Ok(Lease {
            active: self.active.clone(),
            key,
        })
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_record_does_not_block_other_records_or_plugins_and_drop_releases_slots() {
        let service = Coordinator::default();
        let first = service.admit("a", "first").unwrap();
        assert!(service.admit("a", "first").is_err());
        let others: Vec<_> = (0..3)
            .map(|n| service.admit("a", &n.to_string()).unwrap())
            .collect();
        assert!(service.admit("a", "extra").is_err());
        let unrelated = service.admit("b", "first").unwrap();
        drop(first);
        assert!(service.admit("a", "first").is_ok());
        drop((others, unrelated));
        assert!(service.active.lock().unwrap().is_empty());
    }

    #[test]
    fn admission_has_a_global_limit_without_retaining_failed_keys() {
        let service = Coordinator::default();
        let leases: Vec<_> = (0..GLOBAL_LIMIT)
            .map(|n| service.admit(&n.to_string(), "task").unwrap())
            .collect();
        assert!(service.admit("other", "task").is_err());
        drop(leases);
        assert!(service.admit("other", "task").is_ok());
    }

    #[test]
    fn cleanup_leaves_foreground_capacity_and_shares_record_exclusivity() {
        let service = Coordinator::default();
        let first = service.admit_cleanup("plugin", "one").unwrap();
        let second = service.admit_cleanup("plugin", "two").unwrap();
        assert!(service.admit_cleanup("plugin", "three").is_err());
        assert!(service.admit("plugin", "one").is_err());
        let third = service.admit("plugin", "three").unwrap();
        let fourth = service.admit("plugin", "four").unwrap();
        drop((first, second, third, fourth));
        assert!(service.active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_network_future_releases_its_record_without_waiting_for_transport() {
        let service = Arc::new(Coordinator::default());
        let (ready, admitted) = tokio::sync::oneshot::channel();
        let cloned = service.clone();
        let task = tokio::spawn(async move {
            let _lease = cloned.admit("plugin", "cancelled").unwrap();
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        admitted.await.unwrap();
        assert!(service.admit("plugin", "cancelled").is_err());
        assert!(service.admit("unrelated", "other").is_ok());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(service.admit("plugin", "cancelled").is_ok());
    }
}
