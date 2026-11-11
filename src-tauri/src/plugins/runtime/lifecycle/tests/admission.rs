use super::*;
#[test]
fn operation_limits_are_global_and_per_owner_and_retire_unused_entries() {
    let budget = Arc::new(Budget::default());
    let mut active = Vec::new();
    for owner in ["a", "b", "c", "d"] {
        for _ in 0..4 {
            active.push(budget.acquire(owner).unwrap());
        }
        assert!(budget.acquire(owner).is_err());
    }
    assert!(budget.acquire("other").is_err());
    drop(active.pop());
    let other = budget.acquire("other").unwrap();
    drop(active);
    drop(other);
    assert!(budget.0.lock().unwrap().is_empty());
}
#[tokio::test]
async fn disappearing_caller_keeps_submitted_disposal_capacity_until_settlement() {
    let budget = Arc::new(Budget::default());
    let permit = budget.acquire("owner").unwrap();
    let (settle, settled) = tokio::sync::oneshot::channel();
    let worker = tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let _ = settled.await;
    });
    drop(worker);
    assert_eq!(budget.0.lock().unwrap()["owner"], 1);
    settle.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !budget.0.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
