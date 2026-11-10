//! Exact-instance runtime ownership over the authoritative active transfer map.
use super::*;
impl TransferRegistry {
    pub(crate) fn release_owned_resource(
        &self,
        id: &str,
        plugin_id: &str,
        generation: u64,
        identity: &str,
    ) -> bool {
        self.cancel_owned_checked(id, plugin_id, generation, Some(identity))
    }

    pub(super) fn cancel_owned_checked(
        &self,
        id: &str,
        plugin_id: &str,
        generation: u64,
        identity: Option<&str>,
    ) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        let Some(transfer) = state.active.get(id) else {
            return false;
        };
        if identity.is_none_or(|identity| transfer.identity == identity)
            && transfer
                .owner
                .as_ref()
                .is_some_and(|owner| owner.plugin_id == plugin_id && owner.generation == generation)
        {
            transfer.cancel();
            // Explicit cancellation must supersede an earlier pause request.
            state.paused.remove(id);
            true
        } else {
            false
        }
    }

    pub(crate) fn owned_resources(
        &self,
        plugin_id: &str,
        generation: u64,
    ) -> AppResult<Vec<(String, String, bool)>> {
        let state = self
            .inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?;
        Ok(state
            .active
            .iter()
            .filter(|(_, t)| {
                t.owner
                    .as_ref()
                    .is_some_and(|o| o.plugin_id == plugin_id && o.generation == generation)
            })
            .take(4097)
            .map(|(id, t)| {
                (
                    id.clone(),
                    t.identity.clone(),
                    t.cancel.load(Ordering::SeqCst) && !state.paused.contains(id),
                )
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(plugin: &str, generation: u64) -> TransferOwner {
        TransferOwner {
            plugin_id: plugin.into(),
            generation,
            cancelled: tokio::sync::watch::channel(false).0,
        }
    }
    #[test]
    fn cancellation_is_exact_instance_and_keeps_active_capacity_until_worker_finishes() {
        let registry = TransferRegistry::default();
        registry
            .register("user", Arc::new(AtomicBool::new(false)), None)
            .unwrap();
        registry
            .register(
                "same",
                Arc::new(AtomicBool::new(false)),
                Some(owner("one", 1)),
            )
            .unwrap();
        assert!(registry.owned_resources("two", 1).unwrap().is_empty());
        assert!(registry.owned_resources("one", 2).unwrap().is_empty());
        let instance = registry.owned_resources("one", 1).unwrap()[0].1.clone();
        registry.pause("same");
        assert!(!registry.owned_resources("one", 1).unwrap()[0].2);
        assert!(!registry.release_owned_resource("same", "two", 1, &instance));
        assert!(!registry.release_owned_resource("same", "one", 2, &instance));
        assert!(!registry.release_owned_resource("same", "one", 1, "stale"));
        assert!(registry.inner.lock().unwrap().paused.contains("same"));
        assert!(registry.release_owned_resource("same", "one", 1, &instance));
        assert!(!registry.take_paused("same"));
        assert!(registry.owned_resources("one", 1).unwrap()[0].2);
        assert!(registry
            .register(
                "same",
                Arc::new(AtomicBool::new(false)),
                Some(owner("one", 1))
            )
            .is_err());
        let event = registry.inner.lock().unwrap().active["same"].event.clone();
        registry.complete(event);
        assert!(registry.owned_resources("one", 1).unwrap().is_empty());
        registry
            .register(
                "same",
                Arc::new(AtomicBool::new(false)),
                Some(owner("one", 1)),
            )
            .unwrap();
        let replacement = registry.owned_resources("one", 1).unwrap()[0].1.clone();
        assert_ne!(instance, replacement);
        assert!(!registry.release_owned_resource("same", "one", 1, &instance));
        assert!(!registry.owned_resources("one", 1).unwrap()[0].2);
    }
    #[test]
    fn legacy_owned_cancellation_also_supersedes_pause() {
        let registry = TransferRegistry::default();
        registry
            .register(
                "same",
                Arc::new(AtomicBool::new(false)),
                Some(owner("one", 1)),
            )
            .unwrap();
        registry.pause("same");
        assert!(!registry.cancel_owned("same", "two", 1));
        assert!(registry.inner.lock().unwrap().paused.contains("same"));
        assert!(registry.cancel_owned("same", "one", 1));
        assert!(!registry.take_paused("same"));
    }
}
