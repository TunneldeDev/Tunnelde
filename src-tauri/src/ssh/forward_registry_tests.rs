use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture_entry(owner: Option<&str>, generation: Option<u64>) -> ActiveForward {
    ActiveForward {
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
