//! Current-instance ownership and disposal; listener state remains authoritative.
use super::*;
impl ForwardRegistry {
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
        self.take_inner(id, Some(identity), Some((owner, generation)), || Ok(()))
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
