use super::*;

fn register(registry: &TransferRegistry, id: &str) -> AppResult<()> {
    registry.register(id, Arc::new(AtomicBool::new(false)), None)
}

fn event(id: &str) -> TransferEvent {
    TransferEvent {
        id: id.into(),
        plugin_id: None,
        direction: "transfer",
        name: "file".into(),
        transferred: 0,
        total: 1,
        status: TransferStatus::Paused,
        phase: None,
        error: None,
    }
}

#[test]
fn missing_tasks_never_get_an_unrelated_fresh_epoch() {
    let registry = TransferRegistry::default();
    assert!(registry.observation("missing").is_err());
    assert!(registry.begin_cleanup("missing").is_err());
}

#[test]
fn release_retains_original_request_until_its_own_late_reply() {
    let registry = TransferRegistry::default();
    register(&registry, "job").unwrap();
    let original = registry.observation("job").unwrap();
    let receipt = original.begin().unwrap();
    registry.release("job");
    assert_eq!(
        register(&registry, "job").unwrap_err().to_string(),
        "editor.remoteOutcomeUnknown"
    );
    // A different task may complete normally, but cannot settle this request.
    register(&registry, "other").unwrap();
    registry.release("other");
    assert!(register(&registry, "job").is_err());
    receipt.acknowledge();
    register(&registry, "job").unwrap();
    assert!(original.closed());
    assert!(original.begin().is_none());
    assert!(registry.inner.lock().unwrap().unconfirmed.is_empty());
    registry.release("job");
}

#[test]
fn completion_and_result_cache_cleanup_do_not_discard_unknown_requests() {
    let registry = TransferRegistry::default();
    register(&registry, "job").unwrap();
    let original = registry.observation("job").unwrap();
    let receipt = original.begin().unwrap();
    registry.complete(event("job"));
    registry.inner.lock().unwrap().completed.clear();
    for number in 0..300 {
        let id = format!("other-{number}");
        register(&registry, &id).unwrap();
        registry.complete(event(&id));
    }
    assert!(registry.reserve_cleanup("job").is_err());
    receipt.acknowledge();
    let reservation = registry.reserve_cleanup("job").unwrap();
    assert!(original.closed());
    drop(reservation);
}

#[test]
fn cleanup_closes_the_original_epoch_and_retains_its_own_pending_requests() {
    let registry = TransferRegistry::default();
    register(&registry, "job").unwrap();
    let original = registry.observation("job").unwrap();
    let receipt = original.begin().unwrap();
    assert!(registry.begin_cleanup("job").is_err());
    assert!(!original.closed());
    receipt.acknowledge();
    let cleanup = registry.begin_cleanup("job").unwrap();
    assert!(original.closed());
    assert!(original.begin().is_none());
    let pending = cleanup.begin().unwrap();
    registry.release("job");
    assert!(registry.reserve_cleanup("job").is_err());
    pending.acknowledge();
    let reservation = registry.reserve_cleanup("job").unwrap();
    assert!(cleanup.closed());
    drop(reservation);
}

#[test]
fn dropped_receipt_blocks_task_reuse_even_after_shutdown_of_its_worker() {
    let registry = TransferRegistry::default();
    register(&registry, "job").unwrap();
    drop(registry.observation("job").unwrap().begin().unwrap());
    registry.release("job");
    for _ in 0..3 {
        assert!(register(&registry, "job").is_err());
        assert!(registry.reserve_cleanup("job").is_err());
    }
}
