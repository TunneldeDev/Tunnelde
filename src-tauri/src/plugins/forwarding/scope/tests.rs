use super::*;
fn lease(generation: u64) -> Lease {
    Lease {
        id: "plugin".into(),
        fingerprint: "digest".into(),
        permissions: vec![],
        generation,
    }
}
fn open(registry: &Registry, generation: u64) -> (String, Arc<Scope>) {
    let id = registry
        .open(
            lease(generation),
            "token".into(),
            "host".into(),
            "view".into(),
            0,
        )
        .unwrap();
    let scope = registry.get(&id, "token").unwrap();
    (id, scope)
}

#[tokio::test]
async fn closing_cancels_pending_work_and_returns_only_unacknowledged_connections() {
    let registry = Registry::default();
    let (id, scope) = open(&registry, 1);
    scope
        .with_live(|connections| {
            connections.insert("pending".into());
            connections.insert("accepted".into());
            connections.remove("accepted");
            Ok(())
        })
        .unwrap();
    assert!(registry.get(&id, "wrong-token").is_err());
    assert!(registry.close(&id, "wrong-token").is_empty());
    let entered = Arc::new(tokio::sync::Notify::new());
    let task = {
        let (scope, entered) = (scope.clone(), entered.clone());
        tokio::spawn(async move {
            scope
                .guard(async {
                    entered.notify_one();
                    std::future::pending::<AppResult<()>>().await
                })
                .await
        })
    };
    entered.notified().await;
    assert_eq!(registry.close(&id, "token"), ["pending"]);
    assert!(task.await.unwrap().is_err());
    assert!(scope.with_live(|_| Ok(())).is_err());
    assert!(registry.close(&id, "token").is_empty());
}

#[test]
fn quotas_and_generation_cleanup_cannot_retire_a_replacement() {
    let registry = Registry::default();
    let (_, old) = open(&registry, 1);
    let (new_id, new) = open(&registry, 2);
    registry.remove(|_, scope| scope.lease.generation < 2);
    assert!(old.with_live(|_| Ok(())).is_err());
    new.with_live(|_| Ok(())).unwrap();
    for _ in 0..15 {
        open(&registry, 2);
    }
    assert!(registry
        .open(lease(2), "token".into(), "host".into(), "view".into(), 0)
        .is_err());
    registry.close(&new_id, "token");
    open(&registry, 2);
}

#[test]
fn close_and_final_commit_are_serialized_without_holding_registry_during_work() {
    let registry = Arc::new(Registry::default());
    let (id, scope) = open(&registry, 1);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let commit = {
        let scope = scope.clone();
        std::thread::spawn(move || {
            scope.with_live(|_| {
                entered_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            })
        })
    };
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    let closer = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            registry.close(&id, "token");
            closed_tx.send(()).unwrap();
        })
    };
    assert!(closed_rx
        .recv_timeout(std::time::Duration::from_millis(20))
        .is_err());
    finish_tx.send(()).unwrap();
    commit.join().unwrap().unwrap();
    closer.join().unwrap();
    assert!(scope
        .with_live::<()>(|_| panic!("closed commit ran"))
        .is_err());
}

#[tokio::test]
async fn pending_operations_are_bounded_and_capacity_returns_on_completion() {
    let registry = Registry::default();
    let (id, scope) = open(&registry, 1);
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let (scope, entered) = (scope.clone(), entered.clone());
        tasks.push(tokio::spawn(async move {
            scope
                .guard(async {
                    entered.add_permits(1);
                    std::future::pending::<AppResult<()>>().await
                })
                .await
        }));
    }
    entered.acquire_many(4).await.unwrap().forget();
    assert!(scope.guard(async { Ok(()) }).await.is_err());
    registry.close(&id, "token");
    for task in tasks {
        assert!(task.await.unwrap().is_err());
    }
}
