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

struct Origin {
    allowed: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
}
impl crate::services::operations::Authority for Origin {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        if !self.allowed.load(Ordering::Acquire) {
            return Err(AppError::validation("retired-file-origin"));
        }
        effect()
    }
}
impl Drop for Origin {
    fn drop(&mut self) {
        self.released.store(true, Ordering::Release);
    }
}

#[tokio::test]
async fn file_page_transfer_origin_follows_actual_worker_and_queued_mutation_clones() {
    let registry = TransferRegistry::default();
    let allowed = Arc::new(AtomicBool::new(true));
    let released = Arc::new(AtomicBool::new(false));
    let origin = crate::services::operations::WorkLifetime::authorized(Arc::new(Origin {
        allowed: allowed.clone(),
        released: released.clone(),
    }));
    registry
        .register("native-page", Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    registry
        .bind_worker_origin("native-page", origin.clone())
        .unwrap();
    let worker = registry.observation("native-page").unwrap();
    drop(origin); // Native reply receiver has gone; actual worker still owns it.
    assert!(!released.load(Ordering::Acquire));
    allowed.store(false, Ordering::Release);
    let polled = Arc::new(AtomicBool::new(false));
    let flag = polled.clone();
    assert!(worker
        .retained_checked(
            async move {
                flag.store(true, Ordering::Release);
                Ok(())
            },
            map_sftp
        )
        .await
        .is_err());
    assert!(
        !polled.load(Ordering::Acquire),
        "retired origin must not poll a queued mutation"
    );
    let event = registry.inner.lock().unwrap().active["native-page"]
        .event
        .clone();
    registry.complete(event);
    assert!(!registry.is_active("native-page"));
    assert!(
        !released.load(Ordering::Acquire),
        "a still-owned worker clone keeps its fence"
    );
    drop(worker);
    assert!(released.load(Ordering::Acquire));
}

#[test]
fn unacknowledged_native_transfer_request_does_not_release_origin_at_ui_completion() {
    let registry = TransferRegistry::default();
    let released = Arc::new(AtomicBool::new(false));
    registry
        .register("native-page", Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    registry
        .bind_worker_origin(
            "native-page",
            crate::services::operations::WorkLifetime::authorized(Arc::new(Origin {
                allowed: Arc::new(AtomicBool::new(true)),
                released: released.clone(),
            })),
        )
        .unwrap();
    let worker = registry.observation("native-page").unwrap();
    let receipt = worker.begin().unwrap();
    let event = registry.inner.lock().unwrap().active["native-page"]
        .event
        .clone();
    registry.complete(event);
    drop(worker);
    assert!(!released.load(Ordering::Acquire));
    assert!(registry
        .register("native-page", Arc::new(AtomicBool::new(false)), None)
        .is_err());
    receipt.acknowledge();
    registry
        .register("native-page", Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    assert!(released.load(Ordering::Acquire));
    registry.release("native-page");
}
