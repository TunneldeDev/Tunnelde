//! Current-instance ownership and disposal; listener state remains authoritative.
use super::*;
impl ForwardRegistry {
    pub(super) fn remove_matching(
        &self,
        invalidation: Option<String>,
        matches: impl Fn(&ActiveForward) -> bool,
    ) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        if let Some(key) = invalidation {
            self.invalidate(key);
        }
        let ids: Vec<_> = active
            .iter()
            .filter(|(_, item)| matches(item))
            .map(|(id, _)| id.clone())
            .collect();
        let removed: Vec<_> = ids
            .into_iter()
            .filter_map(|id| active.remove(&id))
            .collect();
        drop(active);
        // Even detached cleanup can begin immediately on another runtime thread.
        // Keep entries alive until the registry is unlocked before scheduling it.
        let changed = !removed.is_empty();
        drop(removed);
        if changed {
            self.publish();
        }
    }

    pub(crate) fn owned_resources(
        &self,
        owner: &str,
        generation: u64,
    ) -> AppResult<Vec<(String, String)>> {
        Ok(self
            .active
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?
            .iter()
            .filter(|(_, item)| {
                item.owner.as_deref() == Some(owner)
                    && item.generation == Some(generation)
                    && item.admitted.load(Ordering::Acquire)
            })
            .take(4097)
            .map(|(id, item)| (id.clone(), item.identity.clone()))
            .collect())
    }
    pub(crate) fn take_owned_resource(
        &self,
        owner: &str,
        generation: u64,
        id: &str,
        identity: &str,
    ) -> AppResult<StoppedForward> {
        self.take_inner(
            id,
            StopTarget::Snapshot(Some(identity)),
            Some((owner, generation)),
            || Ok(false),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn exact_owner_generation_and_instance_are_required_before_socket_disposal() {
        let registry = ForwardRegistry::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (cancel, _) = watch::channel(false);
        let item = ActiveForward {
            lifetime: None,
            admitted: Arc::new(AtomicBool::new(true)),
            identity: "instance".into(),
            session: "session".into(),
            owner: Some("owner".into()),
            generation: Some(1),
            cancel,
            listener: Some(tokio::spawn(async move {
                let _listener = listener;
                std::future::pending::<()>().await;
            })),
            remote: None,
        };
        registry.active.lock().unwrap().insert("rule".into(), item);
        assert!(registry.owned_resources("foreign", 1).unwrap().is_empty());
        assert!(registry.owned_resources("owner", 2).unwrap().is_empty());
        for (owner, generation, instance) in [
            ("foreign", 1, "instance"),
            ("owner", 2, "instance"),
            ("owner", 1, "old"),
        ] {
            assert!(registry
                .take_owned_resource(owner, generation, "rule", instance)
                .is_err());
        }
        assert_eq!(
            registry.owned_resources("owner", 1).unwrap(),
            vec![("rule".into(), "instance".into())]
        );
        assert!(TcpListener::bind(address).await.is_err());
        registry
            .take_owned_resource("owner", 1, "rule", "instance")
            .unwrap()
            .finish()
            .await
            .unwrap();
        let _available = TcpListener::bind(address).await.unwrap();
        assert!(registry.owned_resources("owner", 1).unwrap().is_empty());
        assert!(registry
            .take_owned_resource("owner", 1, "rule", "instance")
            .is_err());
        let (cancel, _) = watch::channel(false);
        registry.active.lock().unwrap().insert(
            "rule".into(),
            ActiveForward {
                lifetime: None,
                admitted: Arc::new(AtomicBool::new(true)),
                identity: "replacement".into(),
                session: "session".into(),
                owner: Some("owner".into()),
                generation: Some(1),
                cancel,
                listener: None,
                remote: None,
            },
        );
        assert!(registry
            .take_owned_resource("owner", 1, "rule", "instance")
            .is_err());
        assert_eq!(
            registry.owned_resources("owner", 1).unwrap()[0].1,
            "replacement"
        );
        registry
            .take_owned_resource("owner", 1, "rule", "replacement")
            .unwrap()
            .finish()
            .await
            .unwrap();
    }
}

#[cfg(test)]
mod automation_tests {
    use super::*;
    fn insert(registry: &ForwardRegistry, owner: Option<&str>) {
        registry.active.lock().unwrap().insert(
            "rule".into(),
            ActiveForward {
                lifetime: None,
                admitted: Arc::new(AtomicBool::new(true)),
                identity: "runtime".into(),
                session: "ssh".into(),
                owner: owner.map(str::to_owned),
                generation: owner.map(|_| 1),
                cancel: watch::channel(false).0,
                listener: None,
                remote: None,
            },
        );
    }
    #[tokio::test]
    async fn recovery_snapshot_distinguishes_transport_loss_explicit_stops_and_plugin_ownership() {
        let registry = ForwardRegistry::default();
        insert(&registry, None);
        let snapshot = || registry.inspect_automation(|read| read("rule")).unwrap();
        let running = snapshot();
        assert_eq!(running.session.as_deref(), Some("ssh"));
        assert!(!running.plugin_owned);
        registry.stop_session("ssh");
        let interrupted = snapshot();
        assert!(interrupted.session.is_none());
        assert_eq!(running.stop_revision, interrupted.stop_revision);
        registry.stop("rule").await.unwrap();
        let stopped = snapshot();
        assert_ne!(interrupted.stop_revision, stopped.stop_revision);
        // Stops before network preparation must fence that preparation as well.
        registry.stop("rule").await.unwrap();
        assert_ne!(stopped.stop_revision, snapshot().stop_revision);
        insert(&registry, Some("plugin"));
        assert!(snapshot().plugin_owned);
        registry.stop_generation("plugin", 1);
        assert!(snapshot().session.is_none());
        let before = snapshot().stop_revision;
        registry.stop_all();
        assert_ne!(before, snapshot().stop_revision);
    }
}
