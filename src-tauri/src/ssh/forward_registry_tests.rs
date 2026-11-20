use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture_entry(owner: Option<&str>, generation: Option<u64>) -> ActiveForward {
    ActiveForward {
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
