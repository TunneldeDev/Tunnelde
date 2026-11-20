use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture_entry(owner: Option<&str>, generation: Option<u64>) -> ActiveForward {
    ActiveForward {
        work: crate::services::operations::WorkLifetime::current(),
        lifetime: None,
        admitted: Arc::new(AtomicBool::new(true)),
        identity: uuid::Uuid::new_v4().to_string(),
        session: "session".into(),
        owner: owner.map(str::to_owned),
        generation,
        cancel: watch::channel(false).0,
        listener: None,
        remote: None,
    }
}

#[tokio::test]
async fn every_removal_path_invalidates_only_when_runtime_state_changes() {
    let count = Arc::new(AtomicUsize::new(0));
    let record = count.clone();
    let registry = ForwardRegistry::with_notifier(move || {
        record.fetch_add(1, Ordering::SeqCst);
    });
    registry
        .active
        .lock()
        .unwrap()
        .insert("one".into(), fixture_entry(Some("plugin"), Some(1)));
    registry
        .active
        .lock()
        .unwrap()
        .insert("two".into(), fixture_entry(Some("plugin"), Some(2)));
    registry.stop_generation("other", 1);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    registry.stop_generation("plugin", 1);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    registry.stop_before_generation("plugin", 3);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    registry.stop_before_generation("plugin", 3);
    registry
        .active
        .lock()
        .unwrap()
        .insert("native".into(), fixture_entry(None, None));
    registry.stop_session("other");
    assert_eq!(count.load(Ordering::SeqCst), 2);
    registry.stop_session("session");
    assert_eq!(count.load(Ordering::SeqCst), 3);
    registry
        .active
        .lock()
        .unwrap()
        .insert("explicit".into(), fixture_entry(None, None));
    registry.stop("explicit").await.unwrap();
    registry.stop("explicit").await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 4);
    registry
        .active
        .lock()
        .unwrap()
        .insert("all".into(), fixture_entry(None, None));
    registry.stop_all();
    registry.stop_all();
    assert_eq!(count.load(Ordering::SeqCst), 5);
}

#[test]
fn failed_or_active_edits_and_removals_preserve_resources_and_tickets() {
    let registry = ForwardRegistry::default();
    registry
        .active
        .lock()
        .unwrap()
        .insert("rule".into(), fixture_entry(None, None));
    let ticket = registry.ticket("rule", "session").unwrap();
    assert!(registry
        .edit("rule", || -> AppResult<()> {
            panic!("active edit reached persistence")
        })
        .is_err());
    assert!(registry
        .remove_rule("rule", || Err(AppError::validation("test failure")))
        .is_err());
    assert!(registry.valid_ticket(&ticket));
    assert!(registry.snapshot().unwrap().contains_key("rule"));
    registry.remove_rule("rule", || Ok(true)).unwrap();
    assert!(!registry.valid_ticket(&ticket));
    assert!(registry.snapshot().unwrap().is_empty());
}

#[test]
fn notifications_are_delivered_after_releasing_registry_locks() {
    let reference = Arc::new(Mutex::new(std::sync::Weak::<ForwardRegistry>::new()));
    let inspect = reference.clone();
    let registry = Arc::new(ForwardRegistry::with_notifier(move || {
        let registry = inspect.lock().unwrap().upgrade().unwrap();
        assert!(registry.active.try_lock().is_ok());
        assert!(registry.revisions.try_lock().is_ok());
    }));
    *reference.lock().unwrap() = Arc::downgrade(&registry);
    registry.edit("new", || Ok(())).unwrap();
    registry
        .active
        .lock()
        .unwrap()
        .insert("rule".into(), fixture_entry(None, None));
    registry.remove_rule("rule", || Ok(true)).unwrap();
    registry
        .active
        .lock()
        .unwrap()
        .insert("session".into(), fixture_entry(None, None));
    registry.stop_session("session");
}

#[tokio::test]
async fn retained_stop_cannot_remove_a_replacement_runtime_instance() {
    let registry = ForwardRegistry::default();
    let previous = fixture_entry(Some("plugin"), Some(1));
    let old_identity = previous.identity.clone();
    registry
        .active
        .lock()
        .unwrap()
        .insert("rule".into(), previous);
    registry.stop("rule").await.unwrap();
    let replacement = fixture_entry(Some("plugin"), Some(1));
    let identity = replacement.identity.clone();
    registry
        .active
        .lock()
        .unwrap()
        .insert("rule".into(), replacement);
    assert!(registry
        .take_checked("rule", Some(&old_identity), || Ok(()))
        .is_err());
    assert_eq!(registry.snapshot().unwrap()["rule"].1, identity);
    assert!(registry
        .take_checked("rule", Some(&identity), || Err(AppError::validation(
            "revoked"
        )))
        .is_err());
    registry
        .take_checked("rule", Some(&identity), || Ok(()))
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert!(registry.snapshot().unwrap().is_empty());
}

#[tokio::test]
async fn exact_inactive_stop_rejects_new_listener_without_invalidating_tickets() {
    let registry = ForwardRegistry::default();
    let ticket = registry.ticket("rule", "session").unwrap();
    let mut current = fixture_entry(None, None);
    let identity = current.identity.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    current.listener = Some(tokio::spawn(async move {
        let _listener = listener;
        std::future::pending::<()>().await;
    }));
    registry
        .active
        .lock()
        .unwrap()
        .insert("rule".into(), current);
    // A UI showing a pending start must not stop a listener admitted since.
    assert!(registry.take_snapshot("rule", None, || Ok(())).is_err());
    assert!(registry.valid_ticket(&ticket));
    assert_eq!(registry.snapshot().unwrap()["rule"].1, identity);
    assert!(TcpListener::bind(address).await.is_err());
    assert!(registry
        .take_snapshot("rule", Some(&identity), || {
            Err(AppError::validation("forward.changed"))
        })
        .is_err());
    assert!(registry.valid_ticket(&ticket));
    registry
        .take_snapshot("rule", Some(&identity), || Ok(()))
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert!(!registry.valid_ticket(&ticket));
    let _released = TcpListener::bind(address).await.unwrap();
    let inactive = registry.ticket("rule", "session").unwrap();
    // Capturing absence still fences any already prepared future admission.
    registry
        .take_snapshot("rule", None, || Ok(()))
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert!(!registry.valid_ticket(&inactive));
    assert!(registry.snapshot().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_checked_stop_delivery_still_releases_socket_and_connection_lifetime() {
    let registry = ForwardRegistry::default();
    struct Lifetime(Arc<AtomicUsize>);
    impl Drop for Lifetime {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let released = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut entry = fixture_entry(None, None);
    let identity = entry.identity.clone();
    entry.lifetime = Some(Arc::new(Lifetime(released.clone())));
    entry.listener = Some(tokio::spawn(async move {
        let _listener = listener;
        std::future::pending::<()>().await;
    }));
    registry.active.lock().unwrap().insert("rule".into(), entry);
    let stopped = registry
        .take_snapshot("rule", Some(&identity), || Ok(()))
        .unwrap();
    // An abandoned JS/RPC response drops this join handle, not native cleanup.
    drop(stopped);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if released.load(Ordering::SeqCst) == 1 {
                let _listener = TcpListener::bind(address).await.unwrap();
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(registry.snapshot().unwrap().is_empty());
    assert_eq!(released.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn conditional_removal_checks_runtime_before_committing_and_preserves_failed_resources() {
    let publications = Arc::new(AtomicUsize::new(0));
    let record = publications.clone();
    let registry = ForwardRegistry::with_notifier(move || {
        record.fetch_add(1, Ordering::SeqCst);
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut entry = fixture_entry(None, None);
    let identity = entry.identity.clone();
    entry.listener = Some(tokio::spawn(async move {
        let _listener = listener;
        std::future::pending::<()>().await;
    }));
    registry.active.lock().unwrap().insert("rule".into(), entry);
    let ticket = registry.ticket("rule", "session").unwrap();
    for expected in [None, Some("old-runtime")] {
        assert!(registry
            .remove_snapshot("rule", expected, || {
                panic!("stale runtime reached metadata deletion")
            })
            .is_err());
    }
    assert!(registry
        .remove_snapshot("rule", Some(&identity), || {
            Err(AppError::validation("database rejected deletion"))
        })
        .is_err());
    assert!(registry.valid_ticket(&ticket));
    assert_eq!(registry.snapshot().unwrap()["rule"].1, identity);
    assert_eq!(publications.load(Ordering::SeqCst), 0);
    assert!(TcpListener::bind(address).await.is_err());
    let removed = registry
        .remove_snapshot("rule", Some(&identity), || {
            // Persistence and listener removal use the same admission lock.
            assert!(registry.active.try_lock().is_err());
            Ok(true)
        })
        .unwrap();
    assert!(!registry.valid_ticket(&ticket));
    assert!(registry.snapshot().unwrap().is_empty());
    assert_eq!(publications.load(Ordering::SeqCst), 1);
    removed.finish().await.unwrap();
    let _released = TcpListener::bind(address).await.unwrap();
    // A deleted inactive rule still publishes its committed metadata change.
    registry
        .remove_snapshot("inactive", None, || Ok(true))
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert_eq!(publications.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cancelled_conditional_removal_delivery_keeps_cleanup_and_transport_lifetime() {
    struct Lifetime(Arc<AtomicUsize>);
    impl Drop for Lifetime {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let registry = ForwardRegistry::default();
    let released = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut entry = fixture_entry(None, None);
    let identity = entry.identity.clone();
    entry.lifetime = Some(Arc::new(Lifetime(released.clone())));
    entry.listener = Some(tokio::spawn(async move {
        let _listener = listener;
        std::future::pending::<()>().await;
    }));
    registry.active.lock().unwrap().insert("rule".into(), entry);
    let cleanup = registry
        .remove_snapshot("rule", Some(&identity), || Ok(true))
        .unwrap();
    drop(cleanup);
    tokio::time::timeout(Duration::from_secs(2), async {
        while released.load(Ordering::SeqCst) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let _listener = TcpListener::bind(address).await.unwrap();
    assert!(registry.snapshot().unwrap().is_empty());
}

#[tokio::test]
async fn removing_one_group_member_keeps_the_shared_transport_and_other_listener_alive() {
    struct Transport(Arc<AtomicUsize>);
    impl Drop for Transport {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let registry = ForwardRegistry::default();
    let released = Arc::new(AtomicUsize::new(0));
    let transport = Arc::new(Transport(released.clone()));
    let mut targets = Vec::new();
    for id in ["first", "sibling"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut entry = fixture_entry(None, None);
        let identity = entry.identity.clone();
        entry.lifetime = Some(transport.clone());
        entry.listener = Some(tokio::spawn(async move {
            let _listener = listener;
            std::future::pending::<()>().await;
        }));
        registry.active.lock().unwrap().insert(id.into(), entry);
        targets.push((id, identity, address));
    }
    drop(transport);
    let sibling_ticket = registry.ticket("sibling", "session").unwrap();
    let (id, identity, address) = &targets[0];
    registry
        .remove_snapshot(id, Some(identity), || Ok(true))
        .unwrap()
        .finish()
        .await
        .unwrap();
    let _first_released = TcpListener::bind(address).await.unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 0);
    assert!(registry.valid_ticket(&sibling_ticket));
    let (id, identity, address) = &targets[1];
    assert_eq!(registry.snapshot().unwrap()[*id].1, *identity);
    assert!(TcpListener::bind(address).await.is_err());
    registry
        .remove_snapshot(id, Some(identity), || Ok(true))
        .unwrap()
        .finish()
        .await
        .unwrap();
    let _sibling_released = TcpListener::bind(address).await.unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 1);
    assert!(registry.snapshot().unwrap().is_empty());
}
